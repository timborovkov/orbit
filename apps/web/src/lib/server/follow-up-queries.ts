import 'server-only';

import { and, asc, desc, eq, ne } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { mergeFollowUpListViews } from '@/lib/runtime/follow-ups/list';
import { X_REPLY_ACTION } from '@/lib/runtime/x/reply-input';
import { agentActivityEvents, followUps, jobs, outboundActions } from '@/lib/schema';

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
      .where(and(eq(followUps.agentId, agentId), eq(followUps.status, 'scheduled')))
      .orderBy(asc(followUps.dueAt), asc(followUps.createdAt)),
    store
      .select(followUpColumns)
      .from(followUps)
      .leftJoin(jobs, eq(jobs.id, followUps.jobId))
      .where(and(eq(followUps.agentId, agentId), ne(followUps.status, 'scheduled')))
      .orderBy(desc(followUps.dueAt), desc(followUps.createdAt))
      .limit(HISTORY_LIMIT),
  ]);

  return mergeFollowUpListViews(scheduled, history);
}

export async function listActivityEventsForAgent(agentId: string, limit = 50) {
  await requireAdmin();
  const store = db();
  const [events, replies] = await Promise.all([
    store
      .select()
      .from(agentActivityEvents)
      .where(eq(agentActivityEvents.agentId, agentId))
      .orderBy(desc(agentActivityEvents.createdAt))
      .limit(limit),
    store
      .select({
        id: outboundActions.id,
        status: outboundActions.status,
        reason: outboundActions.reason,
        provider: outboundActions.provider,
        providerMessageId: outboundActions.providerMessageId,
        updatedAt: outboundActions.updatedAt,
      })
      .from(outboundActions)
      .where(
        and(eq(outboundActions.agentId, agentId), eq(outboundActions.actionType, X_REPLY_ACTION)),
      )
      .orderBy(desc(outboundActions.updatedAt))
      .limit(limit),
  ]);
  return [
    ...events,
    ...replies.map((reply) => {
      const fixture = reply.provider === 'x-fixture';
      return {
        id: reply.id,
        followUpId: null,
        kind: X_REPLY_ACTION,
        summary: `${fixture ? 'Fixture X reply' : 'X reply'} ${reply.status}`,
        detail: reply.providerMessageId ? `Reply ID ${reply.providerMessageId}` : reply.reason,
        createdAt: reply.updatedAt,
      };
    }),
  ]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}
