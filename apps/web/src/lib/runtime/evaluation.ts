import { and, eq, inArray } from 'drizzle-orm';

import {
  budgetViolationMessage,
  checkRequestBudgets,
  parseBudgets,
  type BudgetSnapshot,
} from '@/lib/budgets';
import { db, type Tx } from '@/lib/db';
import { canEnqueueSimulation } from '@/lib/lifecycle';
import { enqueueJob } from '@/lib/queue/jobs';
import { processSimulationRunForOrigin, type SimulationJobClaim } from '@/lib/runtime/execute';
import { openRouterInference } from '@/lib/runtime/openrouter';
import type { ModelCall } from '@/lib/runtime/simulation';
import {
  agents,
  configurations,
  emailMessages,
  evaluationCases,
  evaluationComparisons,
  runs,
  usageCounters,
  type EvaluationCaseSource,
} from '@/lib/schema';

export const EVALUATION_REPLAY_JOB = 'evaluation.replay';

function emptyUsageBucket() {
  return { spendMicros: BigInt(0), requests: 0, outboundActions: 0 };
}

/** Insert a replay-origin run without its own queue job — the comparison job owns execution. */
async function admitReplayRun(
  tx: Tx,
  agent: typeof agents.$inferSelect,
  {
    actor,
    configurationId,
    input,
    recipients,
  }: {
    actor: string;
    configurationId: string;
    input: string;
    recipients: string[];
  },
): Promise<{ runId: string } | { error: string }> {
  const budgets = parseBudgets(agent.budgets);
  const active = (
    await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.agentId, agent.id),
          inArray(runs.status, ['queued', 'running', 'awaiting_approval']),
        ),
      )
  ).length;
  if (active >= budgets.maxConcurrentRuns) {
    return { error: budgetViolationMessage('concurrency') };
  }

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const counters = await tx.select().from(usageCounters).where(eq(usageCounters.agentId, agent.id));
  const day = counters.find((row) => row.period === 'day' && row.periodStart === today);
  const month = counters.find((row) => row.period === 'month' && row.periodStart === monthStart);
  const snapshot: BudgetSnapshot = {
    budgets,
    day: day
      ? {
          spendMicros: day.spendMicros,
          requests: day.requests,
          outboundActions: day.outboundActions,
        }
      : emptyUsageBucket(),
    month: month
      ? {
          spendMicros: month.spendMicros,
          requests: month.requests,
          outboundActions: month.outboundActions,
        }
      : emptyUsageBucket(),
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
      .where(and(eq(configurations.id, configurationId), eq(configurations.agentId, agent.id)))
  ).at(0);
  if (!config) {
    return { error: 'The configuration is unavailable. Refresh and try again.' };
  }

  const deadlineMs = budgets.runDeadlineSeconds * 1000;
  const run = (
    await tx
      .insert(runs)
      .values({
        agentId: agent.id,
        configurationId,
        input,
        origin: 'replay',
        recipients,
        actor,
        status: 'queued',
        result: { steps: [], actions: [], error: null },
        expiresAt: new Date(Date.now() + deadlineMs),
      })
      .returning()
  ).at(0);
  if (!run) throw new Error('Replay run insert failed');
  return { runId: run.id };
}

export async function saveEvaluationCase(input: {
  actor: string;
  agentId: string;
  title: string;
  sourceKind: EvaluationCaseSource;
  sourceRunId?: string | null;
  sourceEmailMessageId?: string | null;
  caseInput: string;
  recipients?: string[];
}): Promise<{ caseId: string } | { error: string }> {
  const title = input.title.trim();
  const caseInput = input.caseInput.trim();
  if (!title) return { error: 'Give this case a short title.' };
  if (!caseInput) return { error: 'The case needs a non-empty input snapshot.' };

  return await db().transaction(async (tx) => {
    const agent = (await tx.select().from(agents).where(eq(agents.id, input.agentId))).at(0);
    if (!agent) return { error: 'Agent not found.' };

    if (input.sourceKind === 'playground' && input.sourceRunId) {
      const source = (
        await tx
          .select()
          .from(runs)
          .where(
            and(
              eq(runs.id, input.sourceRunId),
              eq(runs.agentId, input.agentId),
              eq(runs.origin, 'playground'),
            ),
          )
      ).at(0);
      if (!source) return { error: 'Playground run not found for this agent.' };
    }

    if (input.sourceKind === 'email' && input.sourceEmailMessageId) {
      const source = (
        await tx
          .select({ id: emailMessages.id })
          .from(emailMessages)
          .where(
            and(
              eq(emailMessages.id, input.sourceEmailMessageId),
              eq(emailMessages.agentId, input.agentId),
            ),
          )
      ).at(0);
      if (!source) return { error: 'Inbound email message not found for this agent.' };
    }

    const row = (
      await tx
        .insert(evaluationCases)
        .values({
          agentId: input.agentId,
          title,
          sourceKind: input.sourceKind,
          sourceRunId: input.sourceRunId ?? null,
          sourceEmailMessageId: input.sourceEmailMessageId ?? null,
          input: caseInput,
          recipients: input.recipients ?? [],
          actor: input.actor,
        })
        .returning({ id: evaluationCases.id })
    ).at(0);
    if (!row) throw new Error('Failed to save evaluation case');
    return { caseId: row.id };
  });
}

export async function startEvaluationComparison(input: {
  actor: string;
  agentId: string;
  caseId: string;
  leftConfigurationId: string;
  rightConfigurationId: string;
}): Promise<{ comparisonId: string; jobId: string } | { error: string }> {
  if (input.leftConfigurationId === input.rightConfigurationId) {
    return { error: 'Choose two different configuration versions to compare.' };
  }

  return await db().transaction(async (tx) => {
    const agent = (
      await tx.select().from(agents).where(eq(agents.id, input.agentId)).for('update')
    ).at(0);
    if (!agent) return { error: 'Agent not found.' };
    if (!canEnqueueSimulation(agent.lifecycle)) {
      return {
        error:
          agent.lifecycle === 'paused'
            ? 'This agent is paused. Resume it before starting a comparison.'
            : 'This agent is stopped. Change its lifecycle before starting a comparison.',
      };
    }

    const evaluationCase = (
      await tx
        .select()
        .from(evaluationCases)
        .where(
          and(eq(evaluationCases.id, input.caseId), eq(evaluationCases.agentId, input.agentId)),
        )
    ).at(0);
    if (!evaluationCase) return { error: 'Evaluation case not found.' };

    for (const configurationId of [input.leftConfigurationId, input.rightConfigurationId]) {
      const config = (
        await tx
          .select({ id: configurations.id })
          .from(configurations)
          .where(
            and(eq(configurations.id, configurationId), eq(configurations.agentId, input.agentId)),
          )
      ).at(0);
      if (!config) return { error: 'One of the selected configurations is unavailable.' };
    }

    const comparison = (
      await tx
        .insert(evaluationComparisons)
        .values({
          agentId: input.agentId,
          caseId: input.caseId,
          leftConfigurationId: input.leftConfigurationId,
          rightConfigurationId: input.rightConfigurationId,
          actor: input.actor,
          status: 'queued',
        })
        .returning()
    ).at(0);
    if (!comparison) throw new Error('Failed to create comparison');

    const job = await enqueueJob(tx, {
      type: EVALUATION_REPLAY_JOB,
      payload: {
        comparisonId: comparison.id,
        agentId: input.agentId,
        actor: input.actor,
      },
      idempotencyKey: `evaluation.replay:${comparison.id}`,
      maxAttempts: 3,
    });

    await tx
      .update(evaluationComparisons)
      .set({ jobId: job.id })
      .where(eq(evaluationComparisons.id, comparison.id));

    return { comparisonId: comparison.id, jobId: job.id };
  });
}

async function runReplaySide(
  comparisonId: string,
  side: 'left' | 'right',
  configurationId: string,
  inference: (key: string) => ModelCall,
  signal?: AbortSignal,
): Promise<{ runId: string } | { error: string }> {
  const admitted = await db().transaction(async (tx) => {
    const comparison = (
      await tx
        .select()
        .from(evaluationComparisons)
        .where(eq(evaluationComparisons.id, comparisonId))
        .for('update')
    ).at(0);
    if (!comparison) return { error: 'Comparison not found.' as const };

    const evaluationCase = (
      await tx.select().from(evaluationCases).where(eq(evaluationCases.id, comparison.caseId))
    ).at(0);
    if (!evaluationCase) return { error: 'Evaluation case not found.' as const };

    const agent = (
      await tx.select().from(agents).where(eq(agents.id, comparison.agentId)).for('update')
    ).at(0);
    if (!agent) return { error: 'Agent not found.' as const };
    if (!canEnqueueSimulation(agent.lifecycle)) {
      return { error: `Agent lifecycle ${agent.lifecycle} cannot run replay.` as const };
    }

    const result = await admitReplayRun(tx, agent, {
      actor: comparison.actor,
      configurationId,
      input: evaluationCase.input,
      recipients: evaluationCase.recipients,
    });
    if ('error' in result) return result;

    await tx
      .update(evaluationComparisons)
      .set(side === 'left' ? { leftRunId: result.runId } : { rightRunId: result.runId })
      .where(eq(evaluationComparisons.id, comparisonId));

    return result;
  });

  if ('error' in admitted) return admitted;

  await processSimulationRunForOrigin(admitted.runId, 'replay', inference, signal);
  return admitted;
}

/**
 * Worker entry: replay the saved case input against both configuration versions
 * sequentially through the shared simulation runtime (origin=replay).
 */
export async function processEvaluationReplayJob(
  payload: Record<string, unknown>,
  inference: (key: string) => ModelCall = openRouterInference,
  signal?: AbortSignal,
  _claim?: SimulationJobClaim,
) {
  const comparisonId = typeof payload.comparisonId === 'string' ? payload.comparisonId : null;
  if (!comparisonId) throw new Error('evaluation.replay payload missing comparisonId');

  const comparison = (
    await db()
      .select()
      .from(evaluationComparisons)
      .where(eq(evaluationComparisons.id, comparisonId))
  ).at(0);
  if (!comparison) throw new Error('Comparison not found');
  if (comparison.status === 'completed') return;

  await db()
    .update(evaluationComparisons)
    .set({ status: 'running', error: null })
    .where(eq(evaluationComparisons.id, comparisonId));

  try {
    const left = await runReplaySide(
      comparisonId,
      'left',
      comparison.leftConfigurationId,
      inference,
      signal,
    );
    if ('error' in left) throw new Error(left.error);

    const right = await runReplaySide(
      comparisonId,
      'right',
      comparison.rightConfigurationId,
      inference,
      signal,
    );
    if ('error' in right) throw new Error(right.error);

    await db()
      .update(evaluationComparisons)
      .set({
        status: 'completed',
        finishedAt: new Date(),
        error: null,
        leftRunId: left.runId,
        rightRunId: right.runId,
      })
      .where(eq(evaluationComparisons.id, comparisonId));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Comparison failed.';
    await db()
      .update(evaluationComparisons)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        error: message.slice(0, 500),
      })
      .where(eq(evaluationComparisons.id, comparisonId));
    throw error;
  }
}

export async function finalizeExhaustedEvaluationReplayJob(
  payload: Record<string, unknown>,
  reason: string,
) {
  const comparisonId = typeof payload.comparisonId === 'string' ? payload.comparisonId : null;
  if (!comparisonId) return;
  const detail = reason.trim().slice(0, 200);
  await db()
    .update(evaluationComparisons)
    .set({
      status: 'failed',
      finishedAt: new Date(),
      error: detail
        ? `Job retries exhausted (${detail}).`
        : 'Job retries exhausted after infrastructure failures.',
    })
    .where(
      and(
        eq(evaluationComparisons.id, comparisonId),
        inArray(evaluationComparisons.status, ['queued', 'running']),
      ),
    );
}
