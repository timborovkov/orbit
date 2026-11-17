import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';

import {
  BudgetError,
  budgetViolationMessage,
  checkRequestBudgets,
  checkRunDeadline,
  checkToolStepLimit,
  isBudgetError,
  isTrustedBudgetMessage,
  parseBudgets,
  type BudgetSnapshot,
} from '@/lib/budgets';
import { db } from '@/lib/db';
import { canEnqueueSimulation } from '@/lib/lifecycle';
import { authorizeAction, loadPolicyContext, reserveRequestQuota } from '@/lib/policy/gateway';
import { enqueueJob } from '@/lib/queue/jobs';
import { isRetryableInfrastructureError, retryableStore } from '@/lib/runtime/errors';
import { openRouterInference } from '@/lib/runtime/openrouter';
import { resolveOpenRouterApiKey } from '@/lib/runtime/openrouter-key';
import { simulate, type ModelCall, type SimulationResult } from '@/lib/runtime/simulation';
import { agents, configurations, credentials, jobs, runs, usageCounters } from '@/lib/schema';

export const SIMULATION_JOB_TYPE = 'simulation.run';

function idempotencyKey(parts: string[]) {
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

/**
 * Persist run mutations only while this claim still owns the execution token.
 * A later reclaim rotates the token so stale workers cannot overwrite progress.
 */
async function updateIfOwned(
  runId: string,
  executionToken: string,
  values: Partial<typeof runs.$inferInsert> & { result?: SimulationResult },
) {
  return await db()
    .update(runs)
    .set(values)
    .where(
      and(eq(runs.id, runId), eq(runs.status, 'running'), eq(runs.executionToken, executionToken)),
    )
    .returning({ id: runs.id });
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
}: {
  actor: string;
  agentId: string;
  configurationId: string;
  input: string;
}) {
  const result = await db().transaction(async (tx) => {
    const agent = (await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')).at(
      0,
    );
    if (!agent) return { error: 'Agent not found.' as const };
    if (!canEnqueueSimulation(agent.lifecycle)) {
      return {
        error: 'This agent is stopped. Change its lifecycle before starting a simulation.' as const,
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

async function processSimulationRun(
  runId: string,
  inference: (key: string) => ModelCall = openRouterInference,
  externalSignal?: AbortSignal,
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
    await tx
      .update(runs)
      .set({
        status: 'running',
        executionToken,
        expiresAt: new Date(Date.now() + budgets.runDeadlineSeconds * 1000),
      })
      .where(eq(runs.id, run.id));
    return { skip: false as const, run, agent, config, budgets, executionToken };
  });

  if (!claimed) return;
  if (claimed.skip) return;

  const { run, config, budgets, executionToken } = claimed;
  const startedAt = new Date();
  const deadlineMs = budgets.runDeadlineSeconds * 1000;
  const deadlineSignal = AbortSignal.timeout(deadlineMs);
  const signal = externalSignal
    ? AbortSignal.any([deadlineSignal, externalSignal])
    : deadlineSignal;

  try {
    const credential = (
      await db().select().from(credentials).where(eq(credentials.agentId, run.agentId))
    ).at(0);
    // Agent key → OPENROUTER_API_KEY → inspectable failure. Same path for web and worker.
    const { apiKey } = resolveOpenRouterApiKey(run.agentId, credential?.encryptedKey);
    const call = inference(apiKey);

    const result = await simulate(
      config.config,
      run.input,
      async (request) => {
        if (checkRunDeadline(startedAt, new Date(), budgets)) {
          throw new BudgetError('run-deadline');
        }
        try {
          signal.throwIfAborted();
        } catch {
          throw new BudgetError('cancelled');
        }
        // Check + reserve under an agent row lock so concurrent workers cannot both pass.
        await reserveRequestQuota(run.agentId);
        const response = await call(request);
        if (checkRunDeadline(startedAt, new Date(), budgets)) {
          throw new BudgetError('run-deadline');
        }
        try {
          signal.throwIfAborted();
        } catch {
          throw new BudgetError('cancelled');
        }
        return response;
      },
      async (partial) => {
        await retryableStore(() => updateIfOwned(run.id, executionToken, { result: partial }));
      },
      {
        maxSteps: budgets.maxToolStepsPerRun,
        signal,
        onActions: async (actions, partial, stage) => {
          const stepLimit = checkToolStepLimit(partial.steps.length, budgets);
          if (stepLimit) {
            return actions.map((action) => ({
              ...action,
              policy: 'denied' as const,
              effect: budgetViolationMessage(stepLimit),
            }));
          }
          const ctx = await retryableStore(() => loadPolicyContext(run.agentId, run.actor, run.id));
          if (!ctx) {
            return actions.map((action) => ({
              ...action,
              policy: 'denied' as const,
              effect: 'Agent unavailable for policy checks.',
            }));
          }
          return await Promise.all(
            actions.map(async (action, index) => {
              const decision = await retryableStore(() =>
                authorizeAction(ctx, {
                  type: action.type,
                  payload: { draft: action.draft, reason: action.reason },
                  idempotencyKey: idempotencyKey([
                    run.id,
                    stage,
                    action.type,
                    String(index),
                    action.reason,
                  ]),
                }),
              );
              return {
                ...action,
                policy: decision.decision,
                effect: decision.reasons.join(' '),
              };
            }),
          );
        },
      },
    );

    const terminalStatus = result.error ? ('failed' as const) : ('completed' as const);
    await updateIfOwned(run.id, executionToken, {
      status: terminalStatus,
      finishedAt: new Date(),
      result,
      deferReason: result.error && isTrustedBudgetMessage(result.error) ? result.error : null,
    });
  } catch (error) {
    // Leave the run non-terminal so a reclaimed job can resume after failJob retries.
    if (isRetryableInfrastructureError(error)) throw error;
    const fallback =
      'Unable to complete inference. Check the agent credential or OPENROUTER_API_KEY, server encryption key and provider availability, then try again.';
    let inspectable = fallback;
    let isBudget = false;
    if (isBudgetError(error)) {
      inspectable = error.message;
      isBudget = true;
    } else if (error instanceof Error && error.message === 'Missing OpenRouter credential') {
      inspectable =
        'No OpenRouter credential available. Save an agent key under Access or set OPENROUTER_API_KEY on the server.';
    }
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
  }
}

export async function processSimulationJob(
  payload: Record<string, unknown>,
  inference: (key: string) => ModelCall = openRouterInference,
  signal?: AbortSignal,
) {
  const runId = typeof payload.runId === 'string' ? payload.runId : null;
  if (!runId) throw new Error('simulation.run payload missing runId');
  await processSimulationRun(runId, inference, signal);
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
