import { and, eq, inArray, sql } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import { canAcceptBackgroundWork, type LifecycleState } from '@/lib/lifecycle';
import {
  FOLLOW_UP_ACTIVITY_KINDS,
  FOLLOW_UP_JOB_TYPE,
  followUpJobPayloadSchema,
  type FollowUpOutcomeKind,
} from '@/lib/runtime/follow-ups/types';
import { agentActivityEvents, agents, followUps, jobs } from '@/lib/schema';

type Store = Tx;

function executedOutcome(subject: string, note: string): string {
  const notePart = note.trim() ? ` Note: ${note.trim()}` : '';
  return `Follow-up completed: ${subject}.${notePart} Internal outcome only; no external actions were taken.`;
}

function skippedOutcome(lifecycle: LifecycleState, subject: string): string {
  return `Follow-up skipped: ${subject}. Agent is ${lifecycle}; commitment was not executed.`;
}

async function recordActivity(
  store: Store,
  input: {
    agentId: string;
    followUpId: string;
    kind: string;
    summary: string;
    detail: string;
    now: Date;
  },
) {
  await store.insert(agentActivityEvents).values({
    agentId: input.agentId,
    followUpId: input.followUpId,
    kind: input.kind,
    summary: input.summary,
    detail: input.detail,
    createdAt: input.now,
  });
}

/**
 * Lock order for follow-up mutations: agent row first, then the follow-up row.
 * Matches cancelFollowUp and pause/stop (lockApprovalAgent → skipScheduledFollowUps).
 */
async function lockFollowUpAgent(store: Store, agentId: string) {
  return (
    await store
      .select({ id: agents.id, lifecycle: agents.lifecycle, name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId))
      .for('update')
  ).at(0);
}

/**
 * Finalize a scheduled follow-up exactly once.
 * Returns whether a new terminal outcome was recorded.
 */
export async function finalizeFollowUpExecution(
  followUpId: string,
  options: {
    attempts?: number;
    agentId?: string;
    store?: Store;
  } = {},
): Promise<{ recorded: boolean; status: string }> {
  const run = async (store: Store) => {
    const now = new Date();
    let agentId = options.agentId;
    if (!agentId) {
      const peek = (
        await store
          .select({ agentId: followUps.agentId })
          .from(followUps)
          .where(eq(followUps.id, followUpId))
          .limit(1)
      ).at(0);
      if (!peek) return { recorded: false, status: 'missing' };
      agentId = peek.agentId;
    }

    // Agent-first lock order (same as cancel / lifecycle).
    const agent = await lockFollowUpAgent(store, agentId);
    const row = (
      await store
        .select()
        .from(followUps)
        .where(and(eq(followUps.id, followUpId), eq(followUps.agentId, agentId)))
        .for('update')
    ).at(0);
    if (!row) return { recorded: false, status: 'missing' };
    if (row.status !== 'scheduled') return { recorded: false, status: row.status };

    if (!agent) {
      await store
        .update(followUps)
        .set({
          status: 'failed',
          attempts: options.attempts ?? row.attempts + 1,
          startedAt: now,
          finishedAt: now,
          outcome: 'Follow-up failed: agent no longer exists.',
          outcomeKind: 'failed',
          updatedAt: now,
        })
        .where(and(eq(followUps.id, followUpId), eq(followUps.status, 'scheduled')));
      await recordActivity(store, {
        agentId: row.agentId,
        followUpId,
        kind: FOLLOW_UP_ACTIVITY_KINDS.failed,
        summary: `Follow-up failed: ${row.subject}`,
        detail: 'Agent no longer exists.',
        now,
      });
      return { recorded: true, status: 'failed' };
    }

    const lifecycle = agent.lifecycle;
    const attempts = options.attempts ?? row.attempts + 1;

    if (!canAcceptBackgroundWork(lifecycle)) {
      const outcome = skippedOutcome(lifecycle, row.subject);
      await store
        .update(followUps)
        .set({
          status: 'skipped',
          attempts,
          startedAt: now,
          finishedAt: now,
          outcome,
          outcomeKind: 'skipped_lifecycle',
          cancelledAt: now,
          cancelledBy: 'system:lifecycle',
          cancelReason: `Agent is ${lifecycle}.`,
          updatedAt: now,
        })
        .where(and(eq(followUps.id, followUpId), eq(followUps.status, 'scheduled')));
      await recordActivity(store, {
        agentId: row.agentId,
        followUpId,
        kind: FOLLOW_UP_ACTIVITY_KINDS.skipped,
        summary: `Follow-up skipped (${lifecycle}): ${row.subject}`,
        detail: outcome,
        now,
      });
      return { recorded: true, status: 'skipped' };
    }

    const outcome = executedOutcome(row.subject, row.note);
    await store
      .update(followUps)
      .set({
        status: 'completed',
        attempts,
        startedAt: now,
        finishedAt: now,
        outcome,
        outcomeKind: 'executed' satisfies FollowUpOutcomeKind,
        updatedAt: now,
      })
      .where(and(eq(followUps.id, followUpId), eq(followUps.status, 'scheduled')));
    await recordActivity(store, {
      agentId: row.agentId,
      followUpId,
      kind: FOLLOW_UP_ACTIVITY_KINDS.completed,
      summary: `Follow-up completed: ${row.subject}`,
      detail: outcome,
      now,
    });
    return { recorded: true, status: 'completed' };
  };

  if (options.store) return run(options.store);
  return db().transaction((tx) => run(tx));
}

/** Worker entry: execute a due follow-up with exact-once semantics. */
export async function processFollowUpJob(
  payload: Record<string, unknown>,
  attempts = 1,
): Promise<void> {
  const parsed = followUpJobPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new Error('Follow-up job payload is invalid.');
  await finalizeFollowUpExecution(parsed.data.followUpId, {
    attempts,
    agentId: parsed.data.agentId,
  });
}

/**
 * When pause/stop cancels pending follow-up jobs, mark matching scheduled
 * commitments as skipped and write activity events (skip-and-record).
 * Caller must already hold the agent row lock (agent-first order).
 */
export async function skipScheduledFollowUpsForLifecycle(
  agentId: string,
  next: 'paused' | 'stopped',
  store: Store,
): Promise<number> {
  // Re-assert agent lock so this path stays agent-first even if a caller forgets.
  await lockFollowUpAgent(store, agentId);
  const now = new Date();
  const rows = await store
    .select()
    .from(followUps)
    .where(and(eq(followUps.agentId, agentId), eq(followUps.status, 'scheduled')))
    .for('update');
  if (!rows.length) return 0;

  const ids = rows.map((row) => row.id);
  await store
    .update(followUps)
    .set({
      status: 'skipped',
      finishedAt: now,
      outcome: `Follow-up skipped: agent ${next}. Commitment was not executed.`,
      outcomeKind: 'skipped_lifecycle',
      cancelledAt: now,
      cancelledBy: 'system:lifecycle',
      cancelReason: `Agent ${next}.`,
      updatedAt: now,
    })
    .where(and(eq(followUps.agentId, agentId), inArray(followUps.id, ids)));

  await store.insert(agentActivityEvents).values(
    rows.map((row) => ({
      agentId,
      followUpId: row.id,
      kind: FOLLOW_UP_ACTIVITY_KINDS.skipped,
      summary: `Follow-up skipped (${next}): ${row.subject}`,
      detail: `Follow-up skipped: ${row.subject}. Agent is ${next}; commitment was not executed.`,
      createdAt: now,
    })),
  );
  return rows.length;
}

export async function finalizeFailedFollowUpJob(
  payload: Record<string, unknown>,
  error: string,
  options: { attempts?: number } = {},
): Promise<void> {
  const parsed = followUpJobPayloadSchema.safeParse(payload);
  if (!parsed.success) return;
  await db().transaction(async (tx) => {
    const now = new Date();
    await lockFollowUpAgent(tx, parsed.data.agentId);
    const row = (
      await tx
        .select()
        .from(followUps)
        .where(
          and(eq(followUps.id, parsed.data.followUpId), eq(followUps.agentId, parsed.data.agentId)),
        )
        .for('update')
    ).at(0);
    if (row?.status !== 'scheduled') return;

    let attempts = options.attempts;
    if (attempts === undefined && row.jobId) {
      const linked = (
        await tx
          .select({ attempts: jobs.attempts })
          .from(jobs)
          .where(eq(jobs.id, row.jobId))
          .limit(1)
      ).at(0);
      attempts = linked?.attempts;
    }
    attempts ??= Math.max(row.attempts, 1);

    const detail = error.slice(0, 2000);
    await tx
      .update(followUps)
      .set({
        status: 'failed',
        attempts,
        finishedAt: now,
        outcome: `Follow-up failed: ${detail}`,
        outcomeKind: 'failed',
        updatedAt: now,
      })
      .where(and(eq(followUps.id, row.id), eq(followUps.status, 'scheduled')));
    await recordActivity(tx, {
      agentId: row.agentId,
      followUpId: row.id,
      kind: FOLLOW_UP_ACTIVITY_KINDS.failed,
      summary: `Follow-up failed: ${row.subject}`,
      detail,
      now,
    });
  });
}

/**
 * Recover scheduled follow-ups whose jobs are already dead but whose
 * onDeadLetter finalization did not commit (lease recovery / crash).
 * Each row is finalized with agent-first locking via finalizeFailedFollowUpJob.
 */
export async function reconcileDeadFollowUpJobs(): Promise<number> {
  const orphaned = await db().execute(sql`
    SELECT
      f.id,
      f.agent_id,
      j.attempts,
      coalesce(j.last_error, 'The worker could not finish the follow-up.') AS last_error
    FROM follow_ups AS f
    INNER JOIN jobs AS j ON j.id = f.job_id
    WHERE f.status = 'scheduled'
      AND j.type = ${FOLLOW_UP_JOB_TYPE}
      AND j.status = 'dead'
  `);
  if (!Array.isArray(orphaned) || orphaned.length === 0) return 0;

  await Promise.all(
    orphaned.map((row) =>
      finalizeFailedFollowUpJob(
        { followUpId: String(row.id), agentId: String(row.agent_id) },
        String(row.last_error),
        { attempts: Number(row.attempts) },
      ),
    ),
  );
  return orphaned.length;
}

export { FOLLOW_UP_JOB_TYPE };
