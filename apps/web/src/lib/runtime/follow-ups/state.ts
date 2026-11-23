import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Tx } from '@/lib/db';
import { cancelAgentJobs } from '@/lib/queue/jobs';
import {
  FOLLOW_UP_ACTIVITY_KINDS,
  type FollowUpOutcomeKind,
  pendingFollowUpStatuses,
} from '@/lib/runtime/follow-ups/types';
import { agentActivityEvents, followUps, runs } from '@/lib/schema';

export type FollowUp = typeof followUps.$inferSelect;
type FollowUpUpdate = typeof followUps.$inferInsert;

const outcomes = {
  executed: ['completed', 'completed'],
  reply_received: ['completed', 'replyReceived'],
  draft_ready: ['completed', 'draftReady'],
  skipped_lifecycle: ['skipped', 'skipped'],
  cancelled: ['cancelled', 'cancelled'],
  failed: ['failed', 'failed'],
} as const;

export async function commitmentClock(tx: Tx) {
  const [clock] = await tx.execute<{ millis: number }>(
    sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::double precision AS millis`,
  );
  if (!clock) throw new Error('Could not read the commitment clock.');
  return new Date(clock.millis);
}

export function recordFollowUpOutcome(
  tx: Tx,
  row: FollowUp,
  outcomeKind: FollowUpOutcomeKind,
  detail: string,
  now: Date,
  fields: Partial<FollowUpUpdate> = {},
) {
  return recordFollowUpOutcomes(tx, row.agentId, [row.id], outcomeKind, detail, now, fields);
}

/** Callers hold the agent lock. Status and Activity commit together. */
export async function recordFollowUpOutcomes(
  tx: Tx,
  agentId: string,
  ids: string[],
  outcomeKind: FollowUpOutcomeKind,
  detail: string,
  now: Date,
  fields: Partial<FollowUpUpdate> = {},
) {
  if (!ids.length) return;
  const [status, activityKind] = outcomes[outcomeKind];
  const changed = await tx
    .update(followUps)
    .set({ ...fields, status, outcomeKind, outcome: detail, finishedAt: now, updatedAt: now })
    .where(
      and(
        eq(followUps.agentId, agentId),
        inArray(followUps.id, ids),
        inArray(followUps.status, pendingFollowUpStatuses),
      ),
    )
    .returning({ id: followUps.id, subject: followUps.subject });
  if (!changed.length) return;
  const label =
    outcomeKind === 'reply_received'
      ? 'Reply received'
      : outcomeKind === 'draft_ready'
        ? 'Follow-up draft ready'
        : `Follow-up ${status}`;
  await tx.insert(agentActivityEvents).values(
    changed.map((row) => ({
      agentId,
      followUpId: row.id,
      kind: FOLLOW_UP_ACTIVITY_KINDS[activityKind],
      summary: `${label}: ${row.subject}`,
      detail,
      createdAt: now,
    })),
  );
}

export async function cancelCommitmentJobs(
  tx: Tx,
  agentId: string,
  rows: FollowUp[],
  reason: string,
  now: Date,
) {
  const draftIds = rows.flatMap(({ draftRunId }) => draftRunId ?? []);
  const drafts = draftIds.length
    ? await tx
        .select({ jobId: runs.jobId })
        .from(runs)
        .where(and(inArray(runs.id, draftIds), eq(runs.agentId, agentId)))
    : [];
  const jobIds = [...rows, ...drafts].flatMap(({ jobId }) => jobId ?? []);
  await cancelAgentJobs(tx, agentId, jobIds, now);
  if (!draftIds.length) return;
  await tx
    .update(runs)
    .set({ status: 'interrupted', finishedAt: now, deferReason: reason })
    .where(
      and(
        inArray(runs.id, draftIds),
        eq(runs.agentId, agentId),
        inArray(runs.status, ['queued', 'running']),
      ),
    );
}
