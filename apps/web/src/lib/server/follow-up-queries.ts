import 'server-only';

import { and, asc, desc, eq, inArray, not, sql } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { channelLabel } from '@/lib/runtime/channels/registry';
import { mergeFollowUpListViews } from '@/lib/runtime/follow-ups/list';
import { pendingFollowUpStatuses } from '@/lib/runtime/follow-ups/types';
import { agentActivityEvents, emailMessages, followUps, jobs, sourceEvents } from '@/lib/schema';

const HISTORY_LIMIT = 100;

const followUpColumns = {
  id: followUps.id,
  agentId: followUps.agentId,
  source: followUps.source,
  createdBy: followUps.createdBy,
  subject: followUps.subject,
  note: followUps.note,
  dueAt: followUps.dueAt,
  status: followUps.status,
  attempts: followUps.attempts,
  jobId: followUps.jobId,
  cancelledAt: followUps.cancelledAt,
  cancelledBy: followUps.cancelledBy,
  cancelReason: followUps.cancelReason,
  startedAt: followUps.startedAt,
  finishedAt: followUps.finishedAt,
  outcome: followUps.outcome,
  outcomeKind: followUps.outcomeKind,
  waitForEvent: followUps.waitForEvent,
  channel: followUps.channel,
  createdAt: followUps.createdAt,
  updatedAt: followUps.updatedAt,
  jobStatus: jobs.status,
  jobAvailableAt: jobs.availableAt,
  jobAttempts: jobs.attempts,
} as const;

/**
 * Load follow-ups for the agent History UI. Scheduled rows are always included
 * (no limit); completed/cancelled/failed/skipped history is capped.
 */
export async function listFollowUpsForAgent(agentId: string) {
  await requireAdmin();
  return selectFollowUpsForAgentView(agentId);
}

/** Selection used by the authorized query and integration tests. */
export async function selectFollowUpsForAgentView(agentId: string) {
  const store = db();
  const [scheduled, history] = await Promise.all([
    store
      .select(followUpColumns)
      .from(followUps)
      .leftJoin(jobs, eq(jobs.id, followUps.jobId))
      .where(
        and(eq(followUps.agentId, agentId), inArray(followUps.status, pendingFollowUpStatuses)),
      )
      .orderBy(asc(followUps.dueAt), asc(followUps.createdAt)),
    store
      .select(followUpColumns)
      .from(followUps)
      .leftJoin(jobs, eq(jobs.id, followUps.jobId))
      .where(
        and(
          eq(followUps.agentId, agentId),
          not(inArray(followUps.status, pendingFollowUpStatuses)),
        ),
      )
      .orderBy(desc(followUps.dueAt), desc(followUps.createdAt))
      .limit(HISTORY_LIMIT),
  ]);

  return mergeFollowUpListViews(scheduled, history);
}

export async function listActivityEventsForAgent(agentId: string, limit = 50) {
  await requireAdmin();
  const rows = await db()
    .select({
      id: agentActivityEvents.id,
      kind: agentActivityEvents.kind,
      summary: agentActivityEvents.summary,
      detail: agentActivityEvents.detail,
      createdAt: agentActivityEvents.createdAt,
      channel: followUps.channel,
      dueAt: followUps.dueAt,
      conversationId: followUps.conversationId,
      originatingRunId: followUps.originatingRunId,
      continuationRunId: followUps.continuationRunId,
      draftRunId: followUps.draftRunId,
      approvalIntentId: followUps.approvalIntentId,
      replyEmailId: emailMessages.id,
      replyEmailExcerpt: sql<string | null>`left(${emailMessages.body}, 280)`,
      replyEventExcerpt: sql<string | null>`left(${sourceEvents.text}, 280)`,
    })
    .from(agentActivityEvents)
    .leftJoin(
      followUps,
      and(
        eq(followUps.id, agentActivityEvents.followUpId),
        eq(followUps.agentId, agentActivityEvents.agentId),
      ),
    )
    .leftJoin(
      emailMessages,
      and(
        eq(emailMessages.id, followUps.replyEmailId),
        eq(emailMessages.agentId, followUps.agentId),
      ),
    )
    .leftJoin(
      sourceEvents,
      and(eq(sourceEvents.id, followUps.replyEventId), eq(sourceEvents.agentId, followUps.agentId)),
    )
    .where(eq(agentActivityEvents.agentId, agentId))
    .orderBy(desc(agentActivityEvents.createdAt), desc(agentActivityEvents.id))
    .limit(limit);

  const agentUrl = `/agents/${agentId}`;
  return rows.map((row) => {
    const isReply = row.kind === 'follow_up.reply_received';
    const isDraft = row.kind === 'follow_up.draft_ready';
    return {
      id: row.id,
      summary: row.summary,
      detail: row.detail,
      createdAt: row.createdAt,
      dueAt: row.dueAt,
      channel: row.channel ? channelLabel(row.channel) : null,
      replyExcerpt: isReply ? (row.replyEmailExcerpt ?? row.replyEventExcerpt) : null,
      links: [
        ...(isReply && row.replyEmailId && row.conversationId
          ? [
              {
                label: 'View reply',
                href: `${agentUrl}?tab=email&emailThread=${encodeURIComponent(row.conversationId)}&emailMessage=${row.replyEmailId}#message-${row.replyEmailId}`,
              },
            ]
          : []),
        ...(isReply && row.continuationRunId
          ? [
              {
                label: 'View continuation',
                href: `${agentUrl}?run=${row.continuationRunId}`,
              },
            ]
          : []),
        ...(isDraft && row.approvalIntentId && row.draftRunId
          ? [
              {
                label: 'View approval',
                href: `/approvals?agent=${agentId}&run=${row.draftRunId}`,
              },
            ]
          : []),
        ...(row.originatingRunId
          ? [
              {
                label: 'View originating run',
                href: `${agentUrl}?run=${row.originatingRunId}`,
              },
            ]
          : []),
      ],
    };
  });
}
