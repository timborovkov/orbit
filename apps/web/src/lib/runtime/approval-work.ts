import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';

import { parseBudgets } from '@/lib/budgets';
import { db, type Tx } from '@/lib/db';
import { enqueueJob } from '@/lib/queue/jobs';
import { channelForRun } from '@/lib/runtime/channels/registry';
import { SIMULATION_JOB_TYPE } from '@/lib/runtime/simulation';
import { recordApprovalDecision } from '@/lib/runtime/telemetry';
import { actionIntents, agents, audit, configurations, policyDecisions, runs } from '@/lib/schema';

type ApprovalAgent = typeof agents.$inferSelect;
type ApprovalIntent = Pick<
  typeof actionIntents.$inferSelect,
  'id' | 'agentId' | 'runId' | 'actionType'
>;

const expiredApprovalReason = 'Approval expired without an administrator decision.';

export async function lockApprovalAgent(tx: Tx, agentId: string) {
  return (await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')).at(0);
}

/** Write the intent, policy decision and audit entry together. The caller owns the agent lock. */
export async function recordApprovalReviews(
  tx: Tx,
  intents: ApprovalIntent[],
  review: {
    actor: string;
    agentName: string;
    status: 'approved' | 'rejected';
    reason: string;
    now: Date;
    payload?: Record<string, unknown>;
    note?: string | null;
    /**
     * Policy outcome after an approval re-check. Defaults to `suppressed` for
     * approved proposals without a write adapter (historical behaviour).
     */
    decision?: 'allow' | 'deny' | 'suppressed';
  },
) {
  if (intents.length === 0) return;
  const approved = review.status === 'approved';
  const decision = approved ? (review.decision ?? 'suppressed') : 'deny';
  await tx
    .update(actionIntents)
    .set({
      decision,
      reasons: [review.reason],
      reviewStatus: review.status,
      reviewedBy: review.actor,
      reviewedAt: review.now,
      reviewExpiresAt: null,
      reviewNote: review.note ?? null,
      ...(review.payload ? { payload: review.payload } : {}),
    })
    .where(
      inArray(
        actionIntents.id,
        intents.map((intent) => intent.id),
      ),
    );
  await tx.insert(policyDecisions).values(
    intents.map(({ id, agentId, runId, actionType }) => ({
      intentId: id,
      agentId,
      runId,
      actionType,
      decision,
      reasons: [review.reason],
      actor: review.actor,
    })),
  );
  await tx.insert(audit).values(
    intents.map(({ id, actionType }) => ({
      actor: review.actor,
      action: `${approved ? 'Approved' : 'Rejected'} ${actionType} for ${review.agentName} (${id}). ${review.reason}`,
    })),
  );
}

/**
 * Resolve a suspended run under its agent lock. Reviews, expiry and suspension all call this
 * in their own transaction so the decision cannot commit without its continuation or end state.
 */
export async function settleApprovalRun(
  tx: Tx,
  agent: ApprovalAgent,
  runId: string,
  actor: string,
) {
  const run = (
    await tx
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.agentId, agent.id)))
      .for('update')
  ).at(0);
  if (run?.status !== 'awaiting_approval') return;

  const reviews = await tx
    .select()
    .from(actionIntents)
    .where(and(eq(actionIntents.runId, runId), isNotNull(actionIntents.reviewStatus)));
  const pending = reviews.filter((intent) => intent.reviewStatus === 'pending');
  const rejection = reviews.find((intent) => intent.reviewStatus === 'rejected');
  const config = (
    await tx
      .select({ settings: configurations.approvalSettings })
      .from(configurations)
      .where(eq(configurations.id, run.configurationId))
  ).at(0);
  const now = new Date();

  if (rejection && (config?.settings?.approvalOnReject ?? agent.approvalOnReject) === 'end') {
    const reason =
      rejection.reviewNote === 'expired'
        ? 'Run ended after an approval expired.'
        : 'Run ended after an administrator rejected a proposal.';
    await recordApprovalReviews(tx, pending, {
      actor,
      agentName: agent.name,
      status: 'rejected',
      reason,
      now,
    });
    const updated = new Map(reviews.map((intent) => [intent.id, intent]));
    await tx
      .update(runs)
      .set({
        status: 'failed',
        finishedAt: now,
        deferReason: null,
        result: {
          ...run.result,
          error: reason,
          actions: run.result.actions.map((action) => {
            const review = action.intentId ? updated.get(action.intentId) : undefined;
            if (!review) return action;
            const draft = review.payload.draft;
            return {
              ...action,
              draft: typeof draft === 'string' || draft === null ? draft : action.draft,
              policy: review.reviewStatus === 'approved' ? 'suppressed' : 'deny',
              effect: review.reviewStatus === 'pending' ? reason : review.reasons.join(' '),
            };
          }),
        },
      })
      .where(eq(runs.id, run.id));
    return 'ended' as const;
  }
  if (pending.length > 0) return;

  const job = await enqueueJob(tx, {
    type: channelForRun(run)?.run.jobType ?? SIMULATION_JOB_TYPE,
    payload: { runId: run.id, agentId: run.agentId, configurationId: run.configurationId, actor },
    idempotencyKey: `simulation:${run.id}:resume:${run.jobId ?? 'initial'}`,
    maxAttempts: 3,
  });
  await tx
    .update(runs)
    .set({
      status: 'queued',
      jobId: job.id,
      deferReason: null,
      finishedAt: null,
      expiresAt: new Date(now.getTime() + parseBudgets(agent.budgets).runDeadlineSeconds * 1000),
    })
    .where(eq(runs.id, run.id));
  return 'queued' as const;
}

/** Repair waits left behind by earlier versions without re-running model stages. */
export async function reconcileSuspendedApprovals(actor = 'system:approval-recovery') {
  const candidates = await db()
    .select({ id: runs.id, agentId: runs.agentId })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .innerJoin(configurations, eq(configurations.id, runs.configurationId))
    .where(
      and(
        eq(runs.status, 'awaiting_approval'),
        sql`(
      NOT EXISTS (
        SELECT 1 FROM action_intents WHERE run_id = ${runs.id} AND review_status = 'pending'
      ) OR (
        coalesce(${configurations.approvalSettings}->>'approvalOnReject', ${agents.approvalOnReject}) = 'end'
        AND EXISTS (
          SELECT 1 FROM action_intents WHERE run_id = ${runs.id} AND review_status = 'rejected'
        )
      )
    )`,
      ),
    )
    .orderBy(runs.createdAt)
    .limit(100);
  for (const { id, agentId } of candidates) {
    await db().transaction(async (tx) => {
      const agent = await lockApprovalAgent(tx, agentId);
      if (agent) await settleApprovalRun(tx, agent, id, actor);
    });
  }
}

export async function expireStaleApprovals(actor = 'system:approval-expiry') {
  const candidates = await db()
    .select({ id: actionIntents.id, agentId: actionIntents.agentId })
    .from(actionIntents)
    .where(
      and(
        eq(actionIntents.reviewStatus, 'pending'),
        lte(actionIntents.reviewExpiresAt, new Date()),
      ),
    )
    .orderBy(actionIntents.reviewExpiresAt)
    .limit(100);
  let expired = 0;
  for (const { id, agentId } of candidates) {
    const intent = await db().transaction(async (tx) => {
      const agent = await lockApprovalAgent(tx, agentId);
      if (!agent) return;
      const now = new Date();
      const intent = (
        await tx
          .select()
          .from(actionIntents)
          .where(
            and(
              eq(actionIntents.id, id),
              eq(actionIntents.reviewStatus, 'pending'),
              lte(actionIntents.reviewExpiresAt, now),
            ),
          )
          .for('update')
      ).at(0);
      if (!intent) return;
      await expireApproval(tx, agent, intent, now, actor);
      return intent;
    });
    if (intent) {
      expired++;
      recordApprovalDecision({
        intentId: intent.id,
        agentId,
        runId: intent.runId,
        decision: 'rejected',
      });
    }
  }
  return { expired };
}

export async function expireApproval(
  tx: Tx,
  agent: ApprovalAgent,
  intent: ApprovalIntent,
  now: Date,
  actor = 'system:approval-expiry',
) {
  await recordApprovalReviews(tx, [intent], {
    actor,
    agentName: agent.name,
    status: 'rejected',
    reason: expiredApprovalReason,
    now,
    note: 'expired',
  });
  if (intent.runId) await settleApprovalRun(tx, agent, intent.runId, actor);
}
