import { and, eq, inArray } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import { canAcceptBackgroundWork, type LifecycleState } from '@/lib/lifecycle';
import {
  FOLLOW_UP_ACTIVITY_KINDS,
  FOLLOW_UP_JOB_TYPE,
  followUpJobPayloadSchema,
  type FollowUpOutcomeKind,
} from '@/lib/runtime/follow-ups/types';
import { agentActivityEvents, agents, followUps } from '@/lib/schema';

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
 * Finalize a scheduled follow-up exactly once.
 * Returns whether a new terminal outcome was recorded.
 */
export async function finalizeFollowUpExecution(
  followUpId: string,
  options: {
    attempts?: number;
    store?: Store;
  } = {},
): Promise<{ recorded: boolean; status: string }> {
  const run = async (store: Store) => {
    const now = new Date();
    const row = (
      await store.select().from(followUps).where(eq(followUps.id, followUpId)).for('update')
    ).at(0);
    if (!row) return { recorded: false, status: 'missing' };
    if (row.status !== 'scheduled') return { recorded: false, status: row.status };

    const agent = (
      await store
        .select({ id: agents.id, lifecycle: agents.lifecycle, name: agents.name })
        .from(agents)
        .where(eq(agents.id, row.agentId))
        .for('update')
    ).at(0);
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
  await finalizeFollowUpExecution(parsed.data.followUpId, { attempts });
}

/**
 * When pause/stop cancels pending follow-up jobs, mark matching scheduled
 * commitments as skipped and write activity events (skip-and-record).
 */
export async function skipScheduledFollowUpsForLifecycle(
  agentId: string,
  next: 'paused' | 'stopped',
  store: Store,
): Promise<number> {
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

  if (rows.length) {
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
  }
  return rows.length;
}

export async function finalizeFailedFollowUpJob(
  payload: Record<string, unknown>,
  error: string,
): Promise<void> {
  const parsed = followUpJobPayloadSchema.safeParse(payload);
  if (!parsed.success) return;
  await db().transaction(async (tx) => {
    const now = new Date();
    const row = (
      await tx
        .select()
        .from(followUps)
        .where(eq(followUps.id, parsed.data.followUpId))
        .for('update')
    ).at(0);
    if (row?.status !== 'scheduled') return;
    const detail = error.slice(0, 2000);
    await tx
      .update(followUps)
      .set({
        status: 'failed',
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

export { FOLLOW_UP_JOB_TYPE };
