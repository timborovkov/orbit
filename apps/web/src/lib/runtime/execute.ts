import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';

import {
  BudgetError,
  budgetViolationMessage,
  checkRequestBudgets,
  checkRunDeadline,
  checkToolStepLimit,
  hasSpendCap,
  isBudgetError,
  isTrustedBudgetMessage,
  parseBudgets,
  type BudgetSnapshot,
} from '@/lib/budgets';
import { db } from '@/lib/db';
import { canEnqueueSimulation } from '@/lib/lifecycle';
import { authorizeAction, loadPolicyContext, reserveRequestQuota } from '@/lib/policy/gateway';
import { deadLetterJob, enqueueJob } from '@/lib/queue/jobs';
import {
  isRetryableInfrastructureError,
  isUnrecoverablePaidStepFinalizationError,
  PAID_STEP_BURN_MESSAGE,
  PaidStepUnpersistedError,
  PreDispatchInfrastructureError,
  RetryableInfrastructureError,
  retryableStore,
  UnrecoverablePaidStepFinalizationError,
} from '@/lib/runtime/errors';
import { openRouterInference } from '@/lib/runtime/openrouter';
import { resolveOpenRouterApiKey } from '@/lib/runtime/openrouter-key';
import { prepareRunTools } from '@/lib/runtime/resources';
import {
  hasSimulationProgress,
  simulate,
  type ModelCall,
  type SimulationResult,
} from '@/lib/runtime/simulation';
import { createRunTelemetry, reportFailure } from '@/lib/runtime/telemetry';
import { agents, configurations, credentials, jobs, runs, usageCounters } from '@/lib/schema';

export const SIMULATION_JOB_TYPE = 'simulation.run';

function idempotencyKey(parts: string[]) {
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

/**
 * Persist run mutations only while this claim still owns the execution token.
 * A later reclaim rotates the token so stale workers cannot overwrite progress.
 */
function mergeQuotaReservations(
  existing: SimulationResult['quotaReservations'],
  incoming: SimulationResult['quotaReservations'],
): SimulationResult['quotaReservations'] {
  if (!existing?.length && !incoming?.length) return incoming ?? existing;
  const byStage = new Map<
    'evaluator' | 'main',
    NonNullable<SimulationResult['quotaReservations']>[number]
  >();
  for (const entry of existing ?? []) byStage.set(entry.stage, entry);
  for (const entry of incoming ?? []) byStage.set(entry.stage, entry);
  return [...byStage.values()];
}

async function updateIfOwned(
  runId: string,
  executionToken: string,
  values: Partial<typeof runs.$inferInsert> & { result?: SimulationResult },
) {
  const incoming = values.result;
  if (!incoming) {
    return await db()
      .update(runs)
      .set(values)
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.status, 'running'),
          eq(runs.executionToken, executionToken),
        ),
      )
      .returning({ id: runs.id });
  }
  // Preserve per-stage quota rows written by reserveRequestQuota so simulate checkpoints
  // cannot wipe idempotency keys that retries must reuse.
  return await db().transaction(async (tx) => {
    const current = (
      await tx
        .select({ id: runs.id, result: runs.result })
        .from(runs)
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.status, 'running'),
            eq(runs.executionToken, executionToken),
          ),
        )
        .for('update')
    ).at(0);
    if (!current) return [];
    const result: SimulationResult = {
      ...incoming,
      quotaReservations: mergeQuotaReservations(
        current.result.quotaReservations,
        incoming.quotaReservations,
      ),
    };
    return await tx
      .update(runs)
      .set({ ...values, result })
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.status, 'running'),
          eq(runs.executionToken, executionToken),
        ),
      )
      .returning({ id: runs.id });
  });
}

/** Abort this claim when another worker has rotated the execution token. */
async function assertOwned(runId: string, executionToken: string) {
  const row = await retryableStore(async () =>
    (
      await db()
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.status, 'running'),
            eq(runs.executionToken, executionToken),
          ),
        )
        .limit(1)
    ).at(0),
  );
  if (!row) throw new BudgetError('cancelled');
}

/**
 * Burn a paid stage as soon as the provider returns, before later ownership checks
 * that may throw Retryable and would otherwise leave only a pending reservation.
 * Reclaim while a call is still in flight still works — nothing is marked until return.
 */
async function markStageDispatchedIfOwned(
  runId: string,
  executionToken: string,
  stage: 'evaluator' | 'main',
) {
  return await db().transaction(async (tx) => {
    const current = (
      await tx
        .select({ id: runs.id, result: runs.result })
        .from(runs)
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.status, 'running'),
            eq(runs.executionToken, executionToken),
          ),
        )
        .for('update')
    ).at(0);
    if (!current) return [];
    const dispatchedStages = [...new Set([...(current.result.dispatchedStages ?? []), stage])];
    return await tx
      .update(runs)
      .set({ result: { ...current.result, dispatchedStages } })
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.status, 'running'),
          eq(runs.executionToken, executionToken),
        ),
      )
      .returning({ id: runs.id });
  });
}

async function expireStaleRuns(
  tx: Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0],
  agentId: string,
) {
  const stale = await tx
    .update(runs)
    .set({ status: 'interrupted', finishedAt: new Date() })
    .where(
      and(
        eq(runs.agentId, agentId),
        inArray(runs.status, ['queued', 'running']),
        lt(runs.expiresAt, new Date()),
      ),
    )
    .returning({ jobId: runs.jobId });
  const jobIds = stale.map((row) => row.jobId).filter((id): id is string => !!id);
  if (jobIds.length) {
    await tx
      .update(jobs)
      .set({
        status: 'cancelled',
        finishedAt: new Date(),
        updatedAt: new Date(),
        claimExpiresAt: null,
        claimedBy: null,
      })
      .where(and(inArray(jobs.id, jobIds), inArray(jobs.status, ['pending', 'claimed'])));
  }
}

/**
 * Transactionally create a queued run and enqueue the durable worker job.
 * The worker owns inference; the web request only persists intent.
 */
export async function enqueueSimulation({
  actor,
  agentId,
  configurationId,
  input,
  recipients = [],
}: {
  actor: string;
  agentId: string;
  configurationId: string;
  input: string;
  recipients?: string[];
}) {
  const result = await db().transaction(async (tx) => {
    const agent = (await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')).at(
      0,
    );
    if (!agent) return { error: 'Agent not found.' as const };
    if (!canEnqueueSimulation(agent.lifecycle)) {
      return {
        error:
          agent.lifecycle === 'paused'
            ? ('This agent is paused. Resume it before starting a simulation.' as const)
            : ('This agent is stopped. Change its lifecycle before starting a simulation.' as const),
      };
    }

    await expireStaleRuns(tx, agentId);

    const budgets = parseBudgets(agent.budgets);
    const active = (
      await tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.agentId, agentId), inArray(runs.status, ['queued', 'running'])))
    ).length;
    if (active >= budgets.maxConcurrentRuns) {
      return {
        error: budgetViolationMessage('concurrency'),
      };
    }

    const today = new Date().toISOString().slice(0, 10);
    const monthStart = `${today.slice(0, 7)}-01`;
    const counters = await tx
      .select()
      .from(usageCounters)
      .where(eq(usageCounters.agentId, agentId));
    const day = counters.find((row) => row.period === 'day' && row.periodStart === today);
    const month = counters.find((row) => row.period === 'month' && row.periodStart === monthStart);
    const snapshot: BudgetSnapshot = {
      budgets,
      day: {
        spendMicros: day?.spendMicros ?? BigInt(0),
        requests: day?.requests ?? 0,
        outboundActions: day?.outboundActions ?? 0,
      },
      month: {
        spendMicros: month?.spendMicros ?? BigInt(0),
        requests: month?.requests ?? 0,
        outboundActions: month?.outboundActions ?? 0,
      },
      activeRuns: active,
    };
    const violation = checkRequestBudgets({ ...snapshot, activeRuns: 0 });
    if (violation && violation !== 'concurrency') {
      return { error: budgetViolationMessage(violation) };
    }

    const config = (
      await tx
        .select()
        .from(configurations)
        .where(and(eq(configurations.id, configurationId), eq(configurations.agentId, agentId)))
    ).at(0);
    if (!config) {
      return {
        error: 'The configuration is unavailable. Refresh and try again.' as const,
      };
    }

    const deadlineMs = budgets.runDeadlineSeconds * 1000;
    const run = (
      await tx
        .insert(runs)
        .values({
          agentId,
          configurationId,
          input,
          recipients,
          actor,
          status: 'queued',
          result: { steps: [], actions: [], error: null },
          expiresAt: new Date(Date.now() + deadlineMs),
        })
        .returning()
    ).at(0);
    if (!run) throw new Error('Run insert failed');

    const job = await enqueueJob(tx, {
      type: SIMULATION_JOB_TYPE,
      payload: { runId: run.id, agentId, configurationId, actor },
      idempotencyKey: `simulation:${run.id}`,
      maxAttempts: 3,
    });

    await tx.update(runs).set({ jobId: job.id }).where(eq(runs.id, run.id));
    return { runId: run.id, jobId: job.id };
  });

  if ('error' in result) return result;
  return {
    message: 'Simulation queued. The worker will run it shortly.',
    runId: result.runId,
    jobId: result.jobId,
  };
}

/** Queues then processes inline — used by persistence tests and local sync callers. */
export async function executeSimulation(
  params: {
    actor: string;
    agentId: string;
    configurationId: string;
    input: string;
  },
  inference: (key: string) => ModelCall = openRouterInference,
) {
  const queued = await enqueueSimulation(params);
  if ('error' in queued && queued.error) return queued;
  if (!('runId' in queued) || !queued.runId) return { error: 'Failed to queue simulation.' };
  await processSimulationRun(queued.runId, inference);
  return {
    message: 'Run saved. Inspect its decisions and drafts in run history.',
    runId: queued.runId,
  };
}

export interface SimulationJobClaim {
  jobId: string;
  workerId: string;
}

async function processSimulationRun(
  runId: string,
  inference: (key: string) => ModelCall = openRouterInference,
  externalSignal?: AbortSignal,
  claim?: SimulationJobClaim,
) {
  const claimed = await db().transaction(async (tx) => {
    // Peek without locking so we can take the agent lock before the run lock
    // (same order as enqueueSimulation and persistLifecycle) and avoid deadlocks.
    const peek = (await tx.select().from(runs).where(eq(runs.id, runId))).at(0);
    if (!peek) return null;
    if (peek.status === 'completed' || peek.status === 'failed' || peek.status === 'interrupted') {
      return { skip: true as const, run: peek };
    }

    const agent = (
      await tx.select().from(agents).where(eq(agents.id, peek.agentId)).for('update')
    ).at(0);
    if (!agent) return null;

    // When invoked from the queue worker, prove this claim still owns the job before
    // rotating the execution token. Lock order: agent → job → run (matches pause/stop).
    if (claim) {
      if (peek.jobId && peek.jobId !== claim.jobId) {
        return { skip: true as const, run: peek };
      }
      const jobRow = (
        await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.id, claim.jobId),
              eq(jobs.claimedBy, claim.workerId),
              eq(jobs.status, 'claimed'),
            ),
          )
          .for('update')
      ).at(0);
      if (!jobRow) return { skip: true as const, run: peek };
    }

    const run = (await tx.select().from(runs).where(eq(runs.id, runId)).for('update')).at(0);
    if (!run) return null;
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'interrupted') {
      return { skip: true as const, run };
    }
    if (run.expiresAt < new Date()) {
      await tx
        .update(runs)
        .set({ status: 'interrupted', finishedAt: new Date() })
        .where(eq(runs.id, run.id));
      return { skip: true as const, run: { ...run, status: 'interrupted' as const } };
    }

    const budgets = parseBudgets(agent.budgets);
    const config = (
      await tx
        .select()
        .from(configurations)
        .where(
          and(eq(configurations.id, run.configurationId), eq(configurations.agentId, run.agentId)),
        )
    ).at(0);
    if (!config) return null;
    const executionToken = randomUUID();
    // First claim starts the wall-clock deadline; retries keep the original expiresAt.
    const expiresAt =
      run.status === 'queued'
        ? new Date(Date.now() + budgets.runDeadlineSeconds * 1000)
        : run.expiresAt;
    await tx
      .update(runs)
      .set({
        status: 'running',
        executionToken,
        expiresAt,
      })
      .where(eq(runs.id, run.id));
    return {
      skip: false as const,
      run: { ...run, status: 'running' as const, expiresAt },
      agent,
      config,
      budgets,
      executionToken,
      expiresAt,
    };
  });

  if (!claimed) return;
  if (claimed.skip) return;

  const { run, config, budgets, executionToken, expiresAt, agent } = claimed;
  // Refuse model work for paused/stopped agents even if a job was already claimed.
  if (!canEnqueueSimulation(agent.lifecycle)) {
    const message =
      agent.lifecycle === 'paused'
        ? 'Agent is paused. Resume it before starting new work.'
        : 'Agent is stopped. Change its lifecycle before starting new work.';
    await retryableStore(() =>
      updateIfOwned(run.id, executionToken, {
        status: 'failed',
        finishedAt: new Date(),
        deferReason: message,
        result: {
          steps: [],
          actions: [],
          error: message,
        },
      }),
    );
    return;
  }
  // Reconstruct the original start so deadline checks accumulate across retries.
  const startedAt = new Date(expiresAt.getTime() - budgets.runDeadlineSeconds * 1000);
  const remainingMs = expiresAt.getTime() - Date.now();
  if (remainingMs <= 0) {
    await retryableStore(() =>
      updateIfOwned(run.id, executionToken, {
        status: 'interrupted',
        finishedAt: new Date(),
        deferReason: budgetViolationMessage('run-deadline'),
      }),
    );
    return;
  }
  const deadlineSignal = AbortSignal.timeout(remainingMs);
  const signal = externalSignal
    ? AbortSignal.any([deadlineSignal, externalSignal])
    : deadlineSignal;

  const telemetry = createRunTelemetry({
    runId: run.id,
    agentId: run.agentId,
    configurationId: config.id,
    version: config.version,
    jobId: claim?.jobId,
    lifecycle: agent.lifecycle,
    trigger: 'playground',
  });
  const failureCorrelation = (extra: { stage?: 'evaluator' | 'main' } = {}) => ({
    runId: run.id,
    agentId: run.agentId,
    jobId: claim?.jobId,
    lifecycle: agent.lifecycle,
    traceId: telemetry.traceId,
    ...extra,
  });
  let didComplete = false;
  let statusMessage: string | undefined;
  try {
    const credential = (
      await db().select().from(credentials).where(eq(credentials.agentId, run.agentId))
    ).at(0);
    // Agent key → OPENROUTER_API_KEY → inspectable failure. Same path for web and worker.
    const { apiKey } = resolveOpenRouterApiKey(run.agentId, credential?.encryptedKey);
    const call = inference(apiKey);

    // Include reservation-only progress so a failed post-call checkpoint cannot free the step slot.
    const checkpointed = hasSimulationProgress(run.result) ? run.result : undefined;
    // A prior attempt already burned a paid step but failed to mark the run terminal — finalize
    // without calling the provider again.
    if (checkpointed?.error === PAID_STEP_BURN_MESSAGE) {
      statusMessage = 'paid-step-burn';
      await telemetry.withSpan(
        'orbit.runtime',
        {
          stage: 'main',
          agent_id: run.agentId,
          run_id: run.id,
          job_id: claim?.jobId,
          lifecycle: agent.lifecycle,
          outcome: 'paid-step-burn',
        },
        async () => {
          await retryableStore(() =>
            updateIfOwned(run.id, executionToken, {
              status: 'failed',
              finishedAt: new Date(),
              result: { ...checkpointed, traceId: telemetry.traceId },
            }),
          );
        },
      );
      return;
    }

    const basePolicy = await retryableStore(() =>
      loadPolicyContext(run.agentId, run.actor, run.id),
    );
    if (!basePolicy) {
      await retryableStore(() =>
        updateIfOwned(run.id, executionToken, {
          status: 'failed',
          finishedAt: new Date(),
          result: { steps: [], actions: [], error: 'Agent unavailable for policy checks.' },
        }),
      );
      return;
    }

    const resources = await prepareRunTools({
      agentId: run.agentId,
      policy: basePolicy,
      executionToken,
      signal,
      maxToolSteps: budgets.maxToolStepsPerRun,
    });
    try {
      let settle!: ((billedMicros: number, actualProviderCalls?: number) => Promise<void>) & {
        reservedMicros?: bigint;
      };
      let quote: Awaited<ReturnType<NonNullable<typeof call.quote>>> | undefined;
      const result = await telemetry.inRunContext(() =>
        simulate(
          config.config,
          run.input,
          async (request) => {
            const response = await telemetry.callModel(call, { ...request, quote });
            const stage = request.stage === 'main' ? 'main' : 'evaluator';
            // Persist the dispatch burn before assertOwned / settlement. A Retryable blip after
            // a paid return must not requeue with only a pending reservation (double-spend).
            // We intentionally do not mark before the provider call: that blocked reclaim and
            // pre-return infrastructure retries in smoke tests.
            await telemetry.withSpan(
              'orbit.runtime',
              {
                stage,
                agent_id: run.agentId,
                run_id: run.id,
                job_id: claim?.jobId,
                lifecycle: agent.lifecycle,
              },
              async () => {
                try {
                  const marked = await retryableStore(() =>
                    markStageDispatchedIfOwned(run.id, executionToken, stage),
                  );
                  if (!marked.length) throw new BudgetError('cancelled');
                } catch (error) {
                  if (isBudgetError(error)) throw error;
                  if (isRetryableInfrastructureError(error)) {
                    throw new PaidStepUnpersistedError(stage);
                  }
                  throw error;
                }
              },
            );
            // Settle spend when priced; always pass actual provider calls so unused
            // request slots from a conservative tool-loop reservation are released.
            try {
              const billed = response.costMicros ?? Number(settle.reservedMicros ?? 0);
              await settle(billed, response.providerCalls ?? 1);
            } catch {
              reportFailure('worker.settlement', failureCorrelation({ stage }));
              console.warn('OpenRouter cost settlement failed', { runId: run.id });
            }
            if (checkRunDeadline(startedAt, new Date(), budgets)) {
              throw new BudgetError('run-deadline');
            }
            try {
              signal.throwIfAborted();
            } catch {
              throw new BudgetError('cancelled');
            }
            await assertOwned(run.id, executionToken);
            return response;
          },
          async (partial) => {
            const updated = await retryableStore(() =>
              updateIfOwned(run.id, executionToken, { result: partial }),
            );
            if (!updated.length) throw new BudgetError('cancelled');
          },
          {
            maxSteps: budgets.maxToolStepsPerRun,
            signal,
            initial: checkpointed,
            skillCatalog: resources.skillCatalog,
            tools: resources.tools,
            skillVersions: resources.skillVersions,
            mcpConnections: resources.mcpConnections,
            toolCalls: resources.toolCalls,
            prepare: async (request, partial) => {
              try {
                await telemetry.withSpan(
                  'orbit.budget',
                  {
                    stage: request.stage ?? 'main',
                    agent_id: run.agentId,
                    run_id: run.id,
                    job_id: claim?.jobId,
                    lifecycle: agent.lifecycle,
                  },
                  async () => {
                    if (checkRunDeadline(startedAt, new Date(), budgets)) {
                      throw new BudgetError('run-deadline');
                    }
                    try {
                      signal.throwIfAborted();
                    } catch {
                      throw new BudgetError('cancelled');
                    }
                    const stage = request.stage === 'main' ? 'main' : 'evaluator';
                    const hasTools = Boolean(request.tools && Object.keys(request.tools).length);
                    quote = hasSpendCap(budgets)
                      ? await call.quote?.(request.model, request.signal, {
                          requireTools: hasTools,
                        })
                      : undefined;
                    // Match openRouterInference stopWhen: structured output + room for tool steps.
                    const providerCalls = hasTools
                      ? Math.max(2, (request.maxToolSteps ?? budgets.maxToolStepsPerRun) + 1)
                      : 1;
                    const upperBound =
                      quote?.upperBoundMicros !== undefined
                        ? quote.upperBoundMicros * providerCalls
                        : undefined;
                    const reserved = await reserveRequestQuota(run.agentId, upperBound, {
                      runId: run.id,
                      token: executionToken,
                      signal: request.signal,
                      stage,
                      providerCalls,
                    });
                    settle = reserved;
                    if (reserved.reservation) {
                      const others =
                        partial.quotaReservations?.filter((entry) => entry.stage !== stage) ?? [];
                      partial.quotaReservations = [...others, reserved.reservation];
                    }
                    await assertOwned(run.id, executionToken);
                    if (request.signal.aborted) throw new BudgetError('cancelled');
                  },
                );
              } catch (error) {
                // Quota/store faults here never reached the provider — mark so simulate can
                // release the step reservation and let the queue retry the stage.
                if (isBudgetError(error)) throw error;
                if (isRetryableInfrastructureError(error)) {
                  throw new PreDispatchInfrastructureError(error.message);
                }
                throw error;
              }
            },
            onActions: async (actions, partial, stage) => {
              await assertOwned(run.id, executionToken);
              // Tool invocations are gated separately from paid inference stages
              // (evaluator/main). Do not add steps.length — that double-counts.
              const stepLimit = checkToolStepLimit(partial.toolCalls?.length ?? 0, budgets);
              if (stepLimit) {
                await telemetry.withSpan(
                  'orbit.budget',
                  {
                    stage,
                    budget_violation: stepLimit,
                    agent_id: run.agentId,
                    run_id: run.id,
                  },
                  () => undefined,
                );
                return actions.map((action) => ({
                  ...action,
                  policy: 'denied' as const,
                  effect: budgetViolationMessage(stepLimit),
                }));
              }
              const ctx = await retryableStore(() =>
                loadPolicyContext(run.agentId, run.actor, run.id),
              );
              if (!ctx) {
                return actions.map((action) => ({
                  ...action,
                  policy: 'denied' as const,
                  effect: 'Agent unavailable for policy checks.',
                }));
              }
              return await Promise.all(
                actions.map(async (action, index) => {
                  const decision = await telemetry.withSpan(
                    'orbit.policy',
                    {
                      tool: action.type,
                      stage,
                      agent_id: run.agentId,
                      run_id: run.id,
                      job_id: claim?.jobId,
                      lifecycle: agent.lifecycle,
                    },
                    async () =>
                      retryableStore(() =>
                        authorizeAction(ctx, {
                          type: action.type,
                          recipients: run.recipients,
                          preliminary: stage === 'evaluator',
                          executionToken,
                          payload: { draft: action.draft, reason: action.reason },
                          idempotencyKey: idempotencyKey([
                            run.id,
                            stage,
                            action.type,
                            String(index),
                            action.reason,
                          ]),
                        }),
                      ),
                  );
                  await telemetry.withSpan(
                    'orbit.tool',
                    {
                      tool: action.type,
                      stage,
                      policy_decision: decision.decision,
                      agent_id: run.agentId,
                      run_id: run.id,
                    },
                    () => undefined,
                  );
                  return {
                    ...action,
                    intentId: decision.intentId,
                    policy: decision.decision,
                    effect: decision.reasons.join(' '),
                  };
                }),
              );
            },
          },
        ),
      );

      // Preserve checkpointed attribution only when main was already paid; otherwise use
      // the resources that actually fed this attempt's main inference.
      const mainWasCheckpointed = checkpointed?.steps.some((step) => step.stage === 'main');
      if (mainWasCheckpointed && result.skillVersions?.length) {
        for (const entry of result.skillVersions) {
          const live = resources.skillVersions.find(
            (row) => row.skillId === entry.skillId && row.version === entry.version,
          );
          if (live?.loaded) entry.loaded = true;
        }
      } else {
        result.skillVersions = resources.skillVersions;
      }
      result.mcpConnections =
        mainWasCheckpointed && result.mcpConnections?.length
          ? result.mcpConnections
          : resources.mcpConnections;
      result.toolCalls = resources.toolCalls;

      const terminalStatus = result.error ? ('failed' as const) : ('completed' as const);
      if (result.error && isTrustedBudgetMessage(result.error)) statusMessage = result.error;
      else if (result.error === PAID_STEP_BURN_MESSAGE) statusMessage = 'paid-step-burn';
      try {
        await retryableStore(() =>
          updateIfOwned(run.id, executionToken, {
            status: terminalStatus,
            finishedAt: new Date(),
            result: { ...result, traceId: telemetry.traceId },
            deferReason: result.error && isTrustedBudgetMessage(result.error) ? result.error : null,
          }),
        );
      } catch (error) {
        // Paid-step burn: never complete the job while the run is still running. Persist the burn
        // markers when possible, then Retryable so the queue retries finalization only (simulate
        // will refuse to redispatch once dispatchedStages/error are durable).
        if (isRetryableInfrastructureError(error) && result.error === PAID_STEP_BURN_MESSAGE) {
          const burned: SimulationResult = {
            ...result,
            traceId: telemetry.traceId,
            error: PAID_STEP_BURN_MESSAGE,
          };
          try {
            await db()
              .update(runs)
              .set({
                status: 'failed',
                finishedAt: new Date(),
                result: burned,
              })
              .where(
                and(
                  eq(runs.id, run.id),
                  eq(runs.status, 'running'),
                  eq(runs.executionToken, executionToken),
                ),
              );
            return;
          } catch {
            try {
              // Burn markers must be durable before an ordinary queue retry, or the next
              // attempt would redispatch the paid stage.
              await db()
                .update(runs)
                .set({ result: burned })
                .where(
                  and(
                    eq(runs.id, run.id),
                    eq(runs.status, 'running'),
                    eq(runs.executionToken, executionToken),
                  ),
                );
            } catch {
              reportFailure('worker.settlement', failureCorrelation());
              // Not durable — do not Retryable-requeue (that would redispatch). Fall through to
              // the non-retryable failure path which best-effort marks the run failed.
              throw new Error(PAID_STEP_BURN_MESSAGE);
            }
            throw new RetryableInfrastructureError(
              'Paid step burn finalization pending; will retry without redistributing the call.',
            );
          }
        }
        throw error;
      }
      didComplete = !result.error;
    } finally {
      await resources.close();
    }
  } catch (error) {
    // Leave the run non-terminal so a reclaimed job can resume after failJob retries.
    if (isRetryableInfrastructureError(error)) throw error;
    if (isUnrecoverablePaidStepFinalizationError(error)) {
      statusMessage = 'force-dead-letter';
      reportFailure('worker.dead_letter', failureCorrelation(), error);
      throw error;
    }
    if (
      !isBudgetError(error) &&
      !(error instanceof Error && error.message === PAID_STEP_BURN_MESSAGE)
    ) {
      reportFailure('worker.runtime', failureCorrelation(), error);
    }
    const fallback =
      'Unable to complete inference. Check the agent credential or OPENROUTER_API_KEY, server encryption key and provider availability, then try again.';
    let inspectable = fallback;
    let isBudget = false;
    if (isBudgetError(error)) {
      inspectable = error.message;
      isBudget = true;
      statusMessage = `budget:${error.kind}`;
    } else if (error instanceof Error && error.message === PAID_STEP_BURN_MESSAGE) {
      inspectable = PAID_STEP_BURN_MESSAGE;
      statusMessage = 'paid-step-burn';
    } else if (error instanceof Error && error.message === 'Missing OpenRouter credential') {
      inspectable =
        'No OpenRouter credential available. Save an agent key under Access or set OPENROUTER_API_KEY on the server.';
    }
    try {
      await db()
        .update(runs)
        .set({
          status: 'failed',
          finishedAt: new Date(),
          deferReason: isBudget ? inspectable : null,
          result: sql`jsonb_set(${runs.result}, '{error}', to_jsonb(${inspectable}::text))`,
        })
        .where(
          and(
            eq(runs.id, run.id),
            eq(runs.status, 'running'),
            eq(runs.executionToken, executionToken),
          ),
        );
    } catch {
      reportFailure('worker.settlement', failureCorrelation());
      // Paid-step burn: never ordinary-retry without a durable marker (redispatch risk).
      if (inspectable === PAID_STEP_BURN_MESSAGE) {
        try {
          await db()
            .update(runs)
            .set({
              result: sql`jsonb_set(
                coalesce(${runs.result}, '{"steps":[],"actions":[],"error":null}'::jsonb),
                '{error}',
                to_jsonb(${PAID_STEP_BURN_MESSAGE}::text)
              )`,
            })
            .where(
              and(
                eq(runs.id, run.id),
                eq(runs.status, 'running'),
                eq(runs.executionToken, executionToken),
              ),
            );
          throw new RetryableInfrastructureError(
            'Paid step burn finalization pending; will retry without redistributing the call.',
          );
        } catch (error) {
          if (isRetryableInfrastructureError(error)) throw error;
          if (claim) {
            try {
              await telemetry.withSpan(
                'orbit.runtime',
                {
                  stage: 'main',
                  agent_id: run.agentId,
                  run_id: run.id,
                  job_id: claim.jobId,
                  lifecycle: agent.lifecycle,
                  outcome: 'force-dead-letter',
                },
                async () => {
                  await deadLetterJob(claim.jobId, claim.workerId, PAID_STEP_BURN_MESSAGE);
                  await finalizeExhaustedSimulationJob({ runId: run.id }, PAID_STEP_BURN_MESSAGE);
                },
              );
              statusMessage = 'force-dead-letter';
              reportFailure('worker.dead_letter', failureCorrelation(), PAID_STEP_BURN_MESSAGE);
              return;
            } catch {
              reportFailure('worker.settlement', failureCorrelation());
            }
          }
          // Worker force-deads; do not Retryable-requeue without a burn marker.
          statusMessage = 'force-dead-letter';
          throw new UnrecoverablePaidStepFinalizationError();
        }
      }
      // Do not return successfully — that would complete the job while the run stays running.
      throw new RetryableInfrastructureError(
        'Failed to persist terminal simulation failure; will retry finalization.',
      );
    }
  } finally {
    await telemetry.finish(!didComplete, statusMessage);
  }
}

export async function processSimulationJob(
  payload: Record<string, unknown>,
  inference: (key: string) => ModelCall = openRouterInference,
  signal?: AbortSignal,
  claim?: SimulationJobClaim,
) {
  const runId = typeof payload.runId === 'string' ? payload.runId : null;
  if (!runId) throw new Error('simulation.run payload missing runId');
  await processSimulationRun(runId, inference, signal, claim);
}

function exhaustedJobMessage(reason: string) {
  const detail = reason.trim().slice(0, 200);
  return detail
    ? `Job retries exhausted after repeated infrastructure failures (${detail}). Check database health and start a new run.`
    : 'Job retries exhausted after repeated infrastructure failures. Check database health and start a new run.';
}

/**
 * When the queue dead-letters a simulation job, clear any non-terminal run so it no
 * longer consumes concurrency and surfaces an inspectable failure.
 */
export async function finalizeExhaustedSimulationJob(
  payload: Record<string, unknown>,
  reason: string,
) {
  const runId = typeof payload.runId === 'string' ? payload.runId : null;
  if (!runId) return;
  const inspectable = exhaustedJobMessage(reason);
  await db()
    .update(runs)
    .set({
      status: 'failed',
      finishedAt: new Date(),
      deferReason: inspectable,
      result: sql`jsonb_set(coalesce(${runs.result}, '{"steps":[],"actions":[],"error":null}'::jsonb), '{error}', to_jsonb(${inspectable}::text))`,
    })
    .where(and(eq(runs.id, runId), inArray(runs.status, ['queued', 'running'])));
}

/**
 * Durable reconcile for dead simulation jobs whose onDeadLetter callback previously failed.
 * Idempotent: only touches queued/running runs linked to dead jobs.
 */
export async function finalizeOrphanedDeadSimulationRuns() {
  const inspectable = exhaustedJobMessage('reconciled after dead-letter callback failure');
  await db().execute(sql`
    UPDATE simulation_runs AS r
    SET
      status = 'failed',
      finished_at = now(),
      defer_reason = ${inspectable},
      result = jsonb_set(
        coalesce(r.result, '{"steps":[],"actions":[],"error":null}'::jsonb),
        '{error}',
        to_jsonb(${inspectable}::text)
      )
    FROM jobs AS j
    WHERE r.job_id = j.id
      AND j.status = 'dead'
      AND j.type = ${SIMULATION_JOB_TYPE}
      AND r.status IN ('queued', 'running')
  `);
}

/**
 * Repair runs left `running` after their job was marked completed (e.g. terminal persistence
 * failed but the worker still acknowledged the claim). Idempotent.
 */
export async function finalizeOrphanedCompletedSimulationRuns() {
  const inspectable = exhaustedJobMessage(
    'reconciled after job completed without run finalization',
  );
  await db().execute(sql`
    UPDATE simulation_runs AS r
    SET
      status = 'failed',
      finished_at = now(),
      defer_reason = ${inspectable},
      result = jsonb_set(
        coalesce(r.result, '{"steps":[],"actions":[],"error":null}'::jsonb),
        '{error}',
        to_jsonb(${inspectable}::text)
      )
    FROM jobs AS j
    WHERE r.job_id = j.id
      AND j.status = 'completed'
      AND j.type = ${SIMULATION_JOB_TYPE}
      AND r.status IN ('queued', 'running')
  `);
}

/** Periodic reconcile for orphaned simulation runs linked to finished jobs. */
export async function reconcileOrphanedSimulationRuns() {
  await finalizeOrphanedDeadSimulationRuns();
  await finalizeOrphanedCompletedSimulationRuns();
}
