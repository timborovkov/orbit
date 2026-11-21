import { createHash, randomUUID } from 'node:crypto';

import { and, eq, inArray, lt, sql } from 'drizzle-orm';

import {
  BudgetError,
  type BudgetSnapshot,
  budgetViolationMessage,
  checkRequestBudgets,
  checkRunDeadline,
  checkToolStepLimit,
  hasSpendCap,
  isBudgetError,
  isTrustedBudgetMessage,
  parseBudgets,
} from '@/lib/budgets';
import { db, type Tx } from '@/lib/db';
import { KNOWLEDGE_SEARCH_TOOL } from '@/lib/knowledge/types';
import { canEnqueueSimulation } from '@/lib/lifecycle';
import { authorizeAction, loadPolicyContext, reserveRequestQuota } from '@/lib/policy/gateway';
import { completeJob, deadLetterJob, enqueueJob } from '@/lib/queue/jobs';
import { actionIdempotencyKey } from '@/lib/runtime/action-idempotency';
import {
  lockApprovalAgent,
  recordApprovalReviews,
  settleApprovalRun,
} from '@/lib/runtime/approval-work';
import { channelAction, channelForRun, channelRunJobTypes } from '@/lib/runtime/channels/registry';
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
import {
  consumeKnowledgeToolStep,
  recordKnowledgeToolCall,
} from '@/lib/runtime/knowledge/tool-step';
import { recallRunMemories } from '@/lib/runtime/memory/recall';
import {
  captureRunMemories,
  memoryRunSource,
  verifiedMemoryCandidates,
} from '@/lib/runtime/memory/store';
import { type MemoryCandidate, memoryCaptureOrigin } from '@/lib/runtime/memory/types';
import { openRouterInference } from '@/lib/runtime/openrouter';
import { resolveOpenRouterApiKey } from '@/lib/runtime/openrouter-key';
import { enqueueOutbound } from '@/lib/runtime/outbound/dispatch';
import { loadRelationshipContext, storeRelationshipNote } from '@/lib/runtime/people/history';
import { prepareRunTools } from '@/lib/runtime/resources';
import {
  hasSimulationProgress,
  type ModelCall,
  simulate,
  type SimulationResult,
} from '@/lib/runtime/simulation';
import { createRunTelemetry, reportFailure } from '@/lib/runtime/telemetry';
import { nativeTools } from '@/lib/runtime/tools/native';
import {
  actionIntents,
  agents,
  type ApprovalOnReject,
  configurations,
  credentials,
  jobs,
  runs,
  usageCounters,
} from '@/lib/schema';

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
  transaction?: Tx,
) {
  const incoming = values.result;
  if (!incoming) {
    return await (transaction ?? db())
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
  const write = async (tx: Tx) => {
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
      dispatchedStages: current.result.dispatchedStages?.length
        ? [...new Set([...current.result.dispatchedStages, ...(incoming.dispatchedStages ?? [])])]
        : incoming.dispatchedStages,
      providerDispatches: current.result.providerDispatches ?? incoming.providerDispatches,
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
  };
  return transaction ? write(transaction) : db().transaction(write);
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
 * Record a generation before dispatch so another claim cannot replay it against
 * the same reservation. A request whose outcome is unknown keeps its reservation.
 */
async function markStageDispatchedIfOwned(
  runId: string,
  executionToken: string,
  stage: 'evaluator' | 'main',
  generation?: number,
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
            sql`${runs.expiresAt} > now()`,
          ),
        )
        .for('update')
    ).at(0);
    if (!current) return [];
    const dispatchedStages = [...new Set([...(current.result.dispatchedStages ?? []), stage])];
    const providerDispatches = current.result.providerDispatches;
    if (generation !== undefined) {
      const reservation = current.result.quotaReservations?.find((entry) => entry.stage === stage);
      if (
        !reservation ||
        generation > (reservation.reservedRequests ?? 1) ||
        generation !== (providerDispatches?.[stage] ?? 0) + 1
      ) {
        throw new BudgetError('cancelled');
      }
    }
    return await tx
      .update(runs)
      .set({
        result: {
          ...current.result,
          dispatchedStages,
          providerDispatches:
            generation === undefined
              ? providerDispatches
              : { ...providerDispatches, [stage]: generation },
        },
      })
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

async function expireStaleRuns(tx: Tx, agent: Pick<typeof agents.$inferSelect, 'id' | 'name'>) {
  // Do not apply the execution deadline to awaiting_approval — that wait is governed by
  // action_intents.review_expires_at / expireStaleApprovals, not run.expiresAt.
  const stale = await tx
    .update(runs)
    .set({
      status: 'interrupted',
      finishedAt: new Date(),
      deferReason: budgetViolationMessage('run-deadline'),
    })
    .where(
      and(
        eq(runs.agentId, agent.id),
        inArray(runs.status, ['queued', 'running']),
        lt(runs.expiresAt, new Date()),
      ),
    )
    .returning({ id: runs.id, jobId: runs.jobId });
  const runIds = stale.map((row) => row.id);
  if (runIds.length) {
    const pending = await tx
      .select()
      .from(actionIntents)
      .where(and(inArray(actionIntents.runId, runIds), eq(actionIntents.reviewStatus, 'pending')));
    await recordApprovalReviews(tx, pending, {
      actor: 'system:run-expiry',
      agentName: agent.name,
      status: 'rejected',
      reason: 'Run reached its execution deadline before suspending for review.',
      now: new Date(),
    });
  }
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

    return admitRun(tx, agent, { actor, configurationId, input, recipients, origin: 'playground' });
  });

  if ('error' in result) return { error: result.error };
  return {
    message: 'Simulation queued. The worker will run it shortly.',
    runId: result.runId,
    jobId: result.jobId,
  };
}

/** Admit and enqueue a run while the caller holds the agent row lock. */
export async function admitRun(
  tx: Tx,
  agent: typeof agents.$inferSelect,
  {
    actor,
    configurationId,
    input,
    origin,
    recipients = [],
    channel,
  }: {
    actor: string;
    configurationId: string;
    input: string;
    origin: typeof runs.$inferSelect.origin;
    recipients?: string[];
    channel?: string;
  },
) {
  const adapter = channelForRun({ origin, channel });
  if (origin === 'channel' && !adapter) return { error: 'Channel is not registered.' };
  const agentId = agent.id;
  await expireStaleRuns(tx, agent);

  const budgets = parseBudgets(agent.budgets);
  const active = (
    await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.agentId, agentId),
          inArray(runs.status, ['queued', 'running', 'awaiting_approval']),
        ),
      )
  ).length;
  if (active >= budgets.maxConcurrentRuns) {
    return {
      error: budgetViolationMessage('concurrency'),
      waitForCapacity: true as const,
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const counters = await tx.select().from(usageCounters).where(eq(usageCounters.agentId, agentId));
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
        origin,
        channel: adapter?.id,
        recipients,
        actor,
        status: 'queued',
        result: { steps: [], actions: [], error: null },
        expiresAt: new Date(Date.now() + deadlineMs),
      })
      .returning()
  ).at(0);
  if (!run) throw new Error('Run insert failed');

  const jobType = adapter?.run.jobType ?? SIMULATION_JOB_TYPE;
  const job = await enqueueJob(tx, {
    type: jobType,
    payload: { runId: run.id, agentId, configurationId, actor },
    idempotencyKey: `${adapter?.run.jobType ?? 'simulation'}:${run.id}`,
    maxAttempts: 3,
  });

  await tx.update(runs).set({ jobId: job.id }).where(eq(runs.id, run.id));
  return { runId: run.id, jobId: job.id };
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
  /** When set, claim validation uses this job type instead of deriving it from origin. */
  jobType?: string;
}

type ReplayOptions = { channel?: string | null; recallQuery: string };

async function processSimulationRun(
  runId: string,
  inference: (key: string) => ModelCall = openRouterInference,
  externalSignal?: AbortSignal,
  claim?: SimulationJobClaim,
  origin: typeof runs.$inferSelect.origin = 'playground',
  replay?: ReplayOptions,
) {
  const claimed = await db().transaction(async (tx) => {
    // Peek without locking so we can take the agent lock before the run lock
    // (same order as enqueueSimulation and persistLifecycle) and avoid deadlocks.
    const peek = (await tx.select().from(runs).where(eq(runs.id, runId))).at(0);
    if (peek?.origin !== origin) return null;
    if (peek.status === 'completed' || peek.status === 'failed' || peek.status === 'interrupted') {
      return { skip: true as const, run: peek };
    }
    // awaiting_approval is only reclaimable when a resume job re-enqueues work.

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
      const expectedType = claim.jobType ?? channelForRun(peek)?.run.jobType ?? SIMULATION_JOB_TYPE;
      const jobRow = (
        await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.id, claim.jobId),
              eq(jobs.type, expectedType),
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
    if (
      run.status === 'completed' ||
      run.status === 'failed' ||
      run.status === 'interrupted' ||
      run.status === 'awaiting_approval'
    ) {
      // awaiting_approval is only resumed after review flips the run back to queued.
      return { skip: true as const, run };
    }
    // Queued claims (first start and post-approval resumes) refresh the deadline below.
    // Only interrupt mid-flight running work whose wall clock already expired.
    // awaiting_approval is skipped earlier and waits on reviewExpiresAt instead.
    if (run.status !== 'queued' && run.expiresAt < new Date()) {
      const deferReason = budgetViolationMessage('run-deadline');
      await tx
        .update(runs)
        .set({ status: 'interrupted', finishedAt: new Date(), deferReason })
        .where(eq(runs.id, run.id));
      return { skip: true as const, run: { ...run, status: 'interrupted' as const, deferReason } };
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
    // First claim and approval resumes (queued) start a fresh deadline; running retries keep it.
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
        deferReason: null,
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
  const adapter = channelForRun({ origin, channel: replay?.channel ?? claimed.run.channel });
  const profile = adapter?.run;
  const channelMode = profile?.mode;
  if (claimed.skip) {
    if (
      origin !== 'replay' &&
      profile?.recover &&
      claimed.run.status === 'completed' &&
      !claimed.run.result.error
    ) {
      const recover = profile.recover;
      await retryableStore(() =>
        recover({
          agentId: claimed.run.agentId,
          runId: claimed.run.id,
          actor: claimed.run.actor,
          result: claimed.run.result,
        }),
      );
    }
    return;
  }

  const { run, config, budgets, executionToken, expiresAt, agent } = claimed;
  if (run.channel && !adapter) {
    const message = 'The run’s channel adapter is unavailable.';
    await retryableStore(() =>
      updateIfOwned(run.id, executionToken, {
        status: 'failed',
        finishedAt: new Date(),
        result: { steps: [], actions: [], error: message },
      }),
    );
    return;
  }
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
    trigger: origin,
    allowContentCapture: !adapter || profile?.allowContentCapture === true,
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
    // Include reservation-only progress so a failed post-call checkpoint cannot free the step slot.
    const checkpointed = hasSimulationProgress(run.result) ? run.result : undefined;
    // Defer credential resolution and inference construction until a model call is required.
    // Reviewed resumes with both stages already checkpointed must not need OpenRouter.
    let resolvedCall: ReturnType<typeof inference> | undefined;
    const ensureCall = async () => {
      if (resolvedCall) return resolvedCall;
      const credential = (
        await db().select().from(credentials).where(eq(credentials.agentId, run.agentId))
      ).at(0);
      // Agent key → OPENROUTER_API_KEY → inspectable failure. Same path for web and worker.
      const { apiKey } = resolveOpenRouterApiKey(run.agentId, credential?.encryptedKey);
      resolvedCall = inference(apiKey);
      return resolvedCall;
    };
    const call: ModelCall = Object.assign(
      async (request: Parameters<ModelCall>[0]) => (await ensureCall())(request),
      {
        quote: async (model: string, signal: AbortSignal, options?: { requireTools?: boolean }) => {
          const resolved = await ensureCall();
          return resolved.quote?.(model, signal, options);
        },
      },
    );
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
              result: { ...checkpointed, pendingMemories: undefined, traceId: telemetry.traceId },
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

    const source = memoryCaptureOrigin(run.origin)
      ? await retryableStore(() => memoryRunSource(run))
      : null;
    const recallQuery = source?.text.join('\n') ?? replay?.recallQuery ?? run.input;
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
            const stage = request.stage === 'main' ? 'main' : 'evaluator';
            const dispatch = { recorded: false };
            const response = await telemetry.callModel(call, {
              ...request,
              quote,
              beforeProviderCall: async (stepNumber) => {
                if (request.signal.aborted) throw new BudgetError('cancelled');
                const marked = await retryableStore(() =>
                  markStageDispatchedIfOwned(run.id, executionToken, stage, stepNumber + 1),
                );
                if (!marked.length) throw new BudgetError('cancelled');
                dispatch.recorded = true;
              },
            });
            // Persist the dispatch burn before assertOwned / settlement. A Retryable blip after
            // a paid return must not requeue with only a pending reservation (double-spend).
            // Injected inference implementations can omit the per-request hook.
            if (!dispatch.recorded)
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
          async (partial, note) => {
            const updated = await retryableStore(() => {
              if (!note || !memoryCaptureOrigin(origin)) {
                return updateIfOwned(run.id, executionToken, { result: partial });
              }
              return db().transaction(async (tx) => {
                const owned = await updateIfOwned(run.id, executionToken, { result: partial }, tx);
                if (owned.length) await storeRelationshipNote(tx, run.agentId, run.id, note);
                return owned;
              });
            });
            if (!updated.length) throw new BudgetError('cancelled');
          },
          {
            channelMode,
            actionTypes:
              channelMode === 'evaluate'
                ? (profile?.proposalTypes ?? adapter?.actions?.map(({ type }) => type) ?? [])
                : undefined,
            memoryCapture: source
              ? {
                  source: source.text,
                  verify: (candidates) => verifiedMemoryCandidates(candidates, source.text),
                }
              : undefined,
            recallMemory: async (requestSignal) => {
              try {
                return await retryableStore(() =>
                  recallRunMemories({
                    agentId: run.agentId,
                    runId: run.id,
                    actor: run.actor,
                    executionToken,
                    query: recallQuery,
                    replay: origin === 'replay',
                    signal: requestSignal,
                  }),
                );
              } catch (error) {
                if (isBudgetError(error) || requestSignal.aborted || origin === 'replay')
                  throw error;
                reportFailure('worker.runtime', failureCorrelation(), error);
                return [];
              }
            },
            summarizeRelationship: Boolean(source),
            loadRelationshipContext: source
              ? () => retryableStore(() => loadRelationshipContext(run.agentId, run.id))
              : undefined,
            maxToolSteps: budgets.maxToolStepsPerRun,
            signal,
            initial: checkpointed,
            skillCatalog: resources.skillCatalog,
            tools: resources.tools,
            skillVersions: resources.skillVersions,
            mcpConnections: resources.mcpConnections,
            toolCalls: resources.toolCalls,
            retrieveKnowledge: agent.enabledTools.includes(KNOWLEDGE_SEARCH_TOOL)
              ? async (requestSignal) => {
                  const query = (
                    profile?.knowledgeQuery?.(run.input) ??
                    source?.text.join('\n') ??
                    run.input
                  ).slice(0, 2000);
                  if (!query) return { status: 'deny', reason: 'No text to search.', hits: [] };
                  const args = { query, limit: 4 };
                  const slot = consumeKnowledgeToolStep(
                    resources.toolSteps,
                    resources.toolCalls,
                    args,
                  );
                  if (!slot.ok) {
                    return { status: 'deny', reason: slot.reason, hits: [] };
                  }
                  try {
                    const { policy, result: searchResult } = await nativeTools[
                      KNOWLEDGE_SEARCH_TOOL
                    ]({
                      actor: run.actor,
                      agentId: run.agentId,
                      runId: run.id,
                      query,
                      limit: 4,
                      idempotencyKey: idempotencyKey([run.id, KNOWLEDGE_SEARCH_TOOL]),
                      execution: { runId: run.id, token: executionToken, signal: requestSignal },
                    });
                    const status = policy.decision === 'allow' ? 'allow' : 'deny';
                    recordKnowledgeToolCall(resources.toolCalls, args, {
                      policy: status,
                      result: searchResult ? { hitCount: searchResult.hits.length } : null,
                      error: status === 'allow' ? undefined : policy.reasons.join(' '),
                    });
                    return {
                      status,
                      reason: policy.reasons.join(' '),
                      hits: searchResult?.hits ?? [],
                    };
                  } catch (error) {
                    if (isBudgetError(error) || requestSignal.aborted) throw error;
                    reportFailure('worker.runtime', failureCorrelation(), error);
                    const reason =
                      'Knowledge retrieval failed. Check the agent’s library and OpenRouter connection.';
                    recordKnowledgeToolCall(resources.toolCalls, args, {
                      policy: 'deny',
                      result: null,
                      error: reason,
                    });
                    return {
                      status: 'failed',
                      reason,
                      hits: [],
                    };
                  }
                }
              : undefined,
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
                      ? (request.maxToolSteps ?? budgets.maxToolStepsPerRun) + 1
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
              if (channelMode === 'draft') return [];
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
                          idempotencyKey: actionIdempotencyKey({
                            runId: run.id,
                            stage,
                            actionType: action.type,
                            index,
                            reason: action.reason,
                          }),
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
                  // Preserve edited drafts from approval review payloads when present.
                  const draft =
                    decision.payload && 'draft' in decision.payload
                      ? typeof decision.payload.draft === 'string' ||
                        decision.payload.draft === null
                        ? decision.payload.draft
                        : action.draft
                      : action.draft;
                  if (
                    stage === 'main' &&
                    decision.decision === 'allow' &&
                    channelAction(action.type)
                  ) {
                    await retryableStore(() =>
                      db().transaction(async (tx) => {
                        if (!(await lockApprovalAgent(tx, run.agentId))) return;
                        const [owned] = await tx
                          .select({ id: runs.id })
                          .from(runs)
                          .where(
                            and(
                              eq(runs.id, run.id),
                              eq(runs.executionToken, executionToken),
                              eq(runs.status, 'running'),
                              sql`${runs.expiresAt} > now()`,
                            ),
                          )
                          .for('update');
                        if (!owned) return;
                        const [intent] = await tx
                          .select()
                          .from(actionIntents)
                          .where(
                            and(
                              eq(actionIntents.id, decision.intentId),
                              eq(actionIntents.agentId, run.agentId),
                            ),
                          );
                        if (intent) await enqueueOutbound(tx, intent, run.actor);
                      }),
                    );
                  }
                  return {
                    ...action,
                    draft,
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

      if (result.error && isTrustedBudgetMessage(result.error)) statusMessage = result.error;
      else if (result.error === PAID_STEP_BURN_MESSAGE) statusMessage = 'paid-step-burn';
      try {
        const { pendingMemories, ...completedResult } = result;
        const traceResult = { ...completedResult, traceId: telemetry.traceId };
        // Adapter completion is idempotent and occurs before the run becomes terminal.
        if (origin !== 'replay' && profile?.complete && !result.error) {
          const complete = profile.complete;
          await retryableStore(() =>
            complete({
              agentId: run.agentId,
              runId: run.id,
              actor: run.actor,
              result: traceResult,
            }),
          );
        }
        const owned = await retryableStore(() =>
          result.error
            ? updateIfOwned(run.id, executionToken, {
                status: 'failed',
                finishedAt: new Date(),
                result: traceResult,
                deferReason: isTrustedBudgetMessage(result.error) ? result.error : null,
              })
            : channelMode === 'draft'
              ? completeSimulation(run, executionToken, traceResult, pendingMemories)
              : finishSimulationWithApprovals(
                  run,
                  executionToken,
                  traceResult,
                  config.approvalSettings?.approvalOnReject,
                  pendingMemories,
                  claim,
                ),
        );
        if (!owned.length) return;
      } catch (error) {
        // Paid-step burn: never complete the job while the run is still running. Persist the burn
        // markers when possible, then Retryable so the queue retries finalization only (simulate
        // will refuse to redispatch once dispatchedStages/error are durable).
        if (isRetryableInfrastructureError(error) && result.error === PAID_STEP_BURN_MESSAGE) {
          const burned: SimulationResult = {
            ...result,
            pendingMemories: undefined,
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

async function completeSimulation(
  run: typeof runs.$inferSelect,
  executionToken: string,
  result: SimulationResult,
  candidates?: MemoryCandidate[],
  transaction?: Tx,
) {
  const values = {
    status: 'completed' as const,
    finishedAt: new Date(),
    result,
    deferReason: null,
  };
  if (!candidates?.length) return updateIfOwned(run.id, executionToken, values, transaction);
  const complete = async (tx: Tx) => {
    await captureRunMemories(tx, run, executionToken, candidates);
    return updateIfOwned(run.id, executionToken, values, tx);
  };
  if (transaction) return complete(transaction);
  return db().transaction(async (tx) => {
    if (!(await lockApprovalAgent(tx, run.agentId))) return [];
    return complete(tx);
  });
}

async function finishSimulationWithApprovals(
  run: typeof runs.$inferSelect,
  executionToken: string,
  result: SimulationResult,
  onReject: ApprovalOnReject | undefined,
  candidates: MemoryCandidate[] | undefined,
  claim?: SimulationJobClaim,
) {
  return db().transaction(async (tx) => {
    const agent = await lockApprovalAgent(tx, run.agentId);
    if (!agent) return [];
    const reviewStatuses =
      (onReject ?? agent.approvalOnReject) === 'end'
        ? (['pending', 'rejected'] as const)
        : (['pending'] as const);
    const review = (
      await tx
        .select({ id: actionIntents.id })
        .from(actionIntents)
        .where(
          and(
            eq(actionIntents.runId, run.id),
            inArray(actionIntents.reviewStatus, [...reviewStatuses]),
          ),
        )
        .limit(1)
    ).at(0);

    if (!review && !result.actions.some((action) => action.policy === 'needs-approval')) {
      return completeSimulation(run, executionToken, result, candidates, tx);
    }

    if (run.jobId) {
      const job = (
        await tx
          .select({ status: jobs.status, claimedBy: jobs.claimedBy })
          .from(jobs)
          .where(eq(jobs.id, run.jobId))
          .for('update')
      ).at(0);
      const ownsJob = claim
        ? claim.jobId === run.jobId && job?.status === 'claimed' && job.claimedBy === claim.workerId
        : job?.status === 'pending';
      if (!ownsJob) return [];
    }
    await captureRunMemories(tx, run, executionToken, candidates);
    const owned = await updateIfOwned(
      run.id,
      executionToken,
      {
        status: 'awaiting_approval',
        finishedAt: null,
        result,
        deferReason: 'Awaiting administrator approval.',
      },
      tx,
    );
    if (!owned.length) return owned;

    if (run.jobId && claim) {
      await completeJob(run.jobId, claim.workerId, tx);
    } else if (run.jobId) {
      const now = new Date();
      await tx
        .update(jobs)
        .set({ status: 'completed', finishedAt: now, updatedAt: now })
        .where(eq(jobs.id, run.jobId));
    }
    await settleApprovalRun(tx, agent, run.id, run.actor);
    return owned;
  });
}

export async function processSimulationJob(
  payload: Record<string, unknown>,
  inference: (key: string) => ModelCall = openRouterInference,
  signal?: AbortSignal,
  claim?: SimulationJobClaim,
) {
  const runId = typeof payload.runId === 'string' ? payload.runId : null;
  if (!runId) throw new Error('simulation.run payload missing runId');
  const [run] = await db()
    .select({ origin: runs.origin, channel: runs.channel })
    .from(runs)
    .where(eq(runs.id, runId));
  if (!run) return;
  const expectedType = channelForRun(run)?.run.jobType ?? SIMULATION_JOB_TYPE;
  if (run.origin === 'replay' || (claim?.jobType ?? SIMULATION_JOB_TYPE) !== expectedType) {
    throw new Error(
      `${run.origin} runs must use ${run.origin === 'replay' ? 'evaluation.replay' : expectedType}`,
    );
  }
  await processSimulationRun(runId, inference, signal, claim, run.origin);
}

export async function processEmailDraftJob(
  payload: Record<string, unknown>,
  inference: (key: string) => ModelCall = openRouterInference,
  signal?: AbortSignal,
  claim?: SimulationJobClaim,
) {
  const runId = typeof payload.runId === 'string' ? payload.runId : null;
  if (!runId) throw new Error('email.draft payload missing runId');
  await processSimulationRun(runId, inference, signal, claim, 'email');
}

/** Process a run whose origin is already set (playground, email, or replay). */
export async function processSimulationRunForOrigin(
  runId: string,
  origin: typeof runs.$inferSelect.origin,
  inference: (key: string) => ModelCall = openRouterInference,
  signal?: AbortSignal,
  claim?: SimulationJobClaim,
  /** Supplies the case's drafting behavior and recall text without changing its safety origin. */
  replay?: ReplayOptions,
) {
  await processSimulationRun(runId, inference, signal, claim, origin, replay);
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
      AND j.type IN (${sql.join(
        channelRunJobTypes(SIMULATION_JOB_TYPE).map((type) => sql`${type}`),
        sql`, `,
      )})
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
      AND j.type IN (${sql.join(
        channelRunJobTypes(SIMULATION_JOB_TYPE).map((type) => sql`${type}`),
        sql`, `,
      )})
      AND r.status IN ('queued', 'running')
  `);
}

/** Periodic reconcile for orphaned simulation runs linked to finished jobs. */
export async function reconcileOrphanedSimulationRuns() {
  await finalizeOrphanedDeadSimulationRuns();
  await finalizeOrphanedCompletedSimulationRuns();
}
