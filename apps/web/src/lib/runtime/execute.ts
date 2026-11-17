import { createHash } from 'node:crypto';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';

import {
  budgetViolationMessage,
  checkRequestBudgets,
  checkRunDeadline,
  checkToolStepLimit,
  isBudgetViolationMessage,
  parseBudgets,
  type BudgetSnapshot,
} from '@/lib/budgets';
import { db } from '@/lib/db';
import { canEnqueueSimulation } from '@/lib/lifecycle';
import { authorizeAction, loadPolicyContext, recordUsage } from '@/lib/policy/gateway';
import { enqueueJob } from '@/lib/queue/jobs';
import { openRouterInference } from '@/lib/runtime/openrouter';
import { resolveOpenRouterApiKey } from '@/lib/runtime/openrouter-key';
import { simulate, type ModelCall, type SimulationResult } from '@/lib/runtime/simulation';
import { agents, configurations, credentials, jobs, runs, usageCounters } from '@/lib/schema';

export const SIMULATION_JOB_TYPE = 'simulation.run';

function idempotencyKey(parts: string[]) {
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

/** Persist run mutations only while the row is still owned as running (never overwrite interrupted). */
async function updateIfRunning(
  runId: string,
  values: Partial<typeof runs.$inferInsert> & { result?: SimulationResult },
) {
  return await db()
    .update(runs)
    .set(values)
    .where(and(eq(runs.id, runId), eq(runs.status, 'running')))
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
    await tx
      .update(runs)
      .set({
        status: 'running',
        expiresAt: new Date(Date.now() + budgets.runDeadlineSeconds * 1000),
      })
      .where(eq(runs.id, run.id));
    return { skip: false as const, run, agent, config, budgets };
  });

  if (!claimed) return;
  if (claimed.skip) return;

  const { run, config, budgets } = claimed;
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
          throw new Error(budgetViolationMessage('run-deadline'));
        }
        try {
          signal.throwIfAborted();
        } catch {
          throw new Error(budgetViolationMessage('run-deadline'));
        }
        const ctx = await loadPolicyContext(run.agentId, run.actor, run.id);
        if (!ctx) throw new Error('Agent unavailable');
        // Counters already include persisted usage from prior calls in this run.
        const snapshot: BudgetSnapshot = {
          budgets: ctx.budgets,
          day: {
            spendMicros: ctx.usage.spendMicros,
            requests: ctx.usage.requests,
            outboundActions: ctx.usage.outboundActions,
          },
          month: {
            spendMicros: ctx.usage.month.spendMicros,
            requests: ctx.usage.month.requests,
            outboundActions: ctx.usage.month.outboundActions,
          },
          activeRuns: ctx.usage.activeRuns,
        };
        const violation = checkRequestBudgets({ ...snapshot, activeRuns: 0 });
        if (violation) throw new Error(budgetViolationMessage(violation));
        // Reserve quota before dispatch so provider failures/timeouts still count.
        await recordUsage(run.agentId, {
          requests: 1,
          spendMicros: BigInt(0), // Token spend tracked; monetary pricing unavailable → documented as 0.
        });
        const response = await call(request);
        if (checkRunDeadline(startedAt, new Date(), budgets)) {
          throw new Error(budgetViolationMessage('run-deadline'));
        }
        try {
          signal.throwIfAborted();
        } catch {
          throw new Error(budgetViolationMessage('run-deadline'));
        }
        return response;
      },
      async (partial) => {
        await updateIfRunning(run.id, { result: partial });
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
          const ctx = await loadPolicyContext(run.agentId, run.actor, run.id);
          if (!ctx) {
            return actions.map((action) => ({
              ...action,
              policy: 'denied' as const,
              effect: 'Agent unavailable for policy checks.',
            }));
          }
          return await Promise.all(
            actions.map(async (action, index) => {
              const decision = await authorizeAction(ctx, {
                type: action.type,
                payload: { draft: action.draft, reason: action.reason },
                idempotencyKey: idempotencyKey([
                  run.id,
                  stage,
                  action.type,
                  String(index),
                  action.reason,
                ]),
              });
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
    const isDeadline =
      !!result.error &&
      (result.error.includes('deadline') || result.error.includes('cancelled this simulation'));
    await updateIfRunning(run.id, {
      status: terminalStatus,
      finishedAt: new Date(),
      result,
      deferReason: isDeadline ? result.error : null,
    });
  } catch (error) {
    const fallback =
      'Unable to complete inference. Check the agent credential or OPENROUTER_API_KEY, server encryption key and provider availability, then try again.';
    const message = error instanceof Error ? error.message : fallback;
    const inspectable =
      message === 'Missing OpenRouter credential'
        ? 'No OpenRouter credential available. Save an agent key under Access or set OPENROUTER_API_KEY on the server.'
        : message === fallback || message.startsWith('Unable to complete')
          ? fallback
          : message;
    const isBudget = isBudgetViolationMessage(inspectable);
    await db()
      .update(runs)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        deferReason: isBudget ? inspectable : null,
        result: sql`jsonb_set(${runs.result}, '{error}', to_jsonb(${inspectable}::text))`,
      })
      .where(and(eq(runs.id, run.id), eq(runs.status, 'running')));
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
