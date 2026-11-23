import { and, eq, gt, inArray, lte, notExists, or, sql } from 'drizzle-orm';

import type { Tx } from '@/lib/db';
import { cancelAgentJobs } from '@/lib/queue/jobs';
import { commitmentClock, recordFollowUpOutcomes } from '@/lib/runtime/follow-ups/state';
import type { CommitmentConversation } from '@/lib/runtime/follow-ups/types';
import { emailMessages, followUps } from '@/lib/schema';

type ReplyEvidence =
  | { kind: 'event'; id: string }
  | {
      kind: 'email';
      id: string;
      messageId?: string | null;
    };

function evidenceColumn(kind: ReplyEvidence['kind']) {
  return kind === 'email' ? followUps.replyEmailId : followUps.replyEventId;
}

/** Intake calls this once, after inserting or hydrating trusted channel evidence under the agent lock. */
export async function resolveConversationReply(
  tx: Tx,
  scope: CommitmentConversation,
  evidence: ReplyEvidence,
) {
  const now = await commitmentClock(tx);
  // A late ancestor can merge a provisional thread without answering a wait
  // created on one of its descendants.
  const messageId = evidence.kind === 'email' ? evidence.messageId : null;
  const followsAnchor = messageId
    ? notExists(
        tx
          .select({ id: emailMessages.id })
          .from(emailMessages)
          .where(
            and(
              eq(emailMessages.id, followUps.anchorId),
              eq(emailMessages.agentId, followUps.agentId),
              or(
                sql`${messageId} = ANY(${emailMessages.inReplyTo})`,
                sql`${messageId} = ANY(${emailMessages.referenceIds})`,
              ),
            ),
          ),
      )
    : undefined;
  const waits = await tx
    .select({ id: followUps.id, jobId: followUps.jobId })
    .from(followUps)
    .where(
      and(
        eq(followUps.agentId, scope.agentId),
        eq(followUps.channel, scope.channel),
        sql`${followUps.accountId} IS NOT DISTINCT FROM ${scope.accountId}::text`,
        eq(followUps.conversationId, scope.conversationId),
        eq(followUps.waitForEvent, 'reply'),
        eq(followUps.status, 'scheduled'),
        lte(followUps.createdAt, now),
        gt(followUps.dueAt, now),
        followsAnchor,
      ),
    );
  if (!waits.length) return;
  await cancelAgentJobs(
    tx,
    scope.agentId,
    waits.flatMap(({ jobId }) => jobId ?? []),
    now,
  );
  await recordFollowUpOutcomes(
    tx,
    scope.agentId,
    waits.map(({ id }) => id),
    'reply_received',
    'A reply was saved in the conversation before the deadline.',
    now,
    evidence.kind === 'email' ? { replyEmailId: evidence.id } : { replyEventId: evidence.id },
  );
}

export async function mergeCommitmentConversations(
  tx: Tx,
  scope: CommitmentConversation,
  replaced: string[],
) {
  await tx
    .update(followUps)
    .set({ conversationId: scope.conversationId })
    .where(
      and(
        eq(followUps.agentId, scope.agentId),
        eq(followUps.channel, scope.channel),
        sql`${followUps.accountId} IS NOT DISTINCT FROM ${scope.accountId}::text`,
        inArray(followUps.conversationId, replaced),
      ),
    );
}

export async function hasReplyCommitment(tx: Tx, agentId: string, evidence: ReplyEvidence) {
  const [commitment] = await tx
    .select({ id: followUps.id })
    .from(followUps)
    .where(and(eq(followUps.agentId, agentId), eq(evidenceColumn(evidence.kind), evidence.id)))
    .limit(1);
  return Boolean(commitment);
}

export async function linkReplyCommitments(
  tx: Tx,
  agentId: string,
  evidence: ReplyEvidence,
  runId: string,
) {
  await tx
    .update(followUps)
    .set({ continuationRunId: runId })
    .where(and(eq(followUps.agentId, agentId), eq(evidenceColumn(evidence.kind), evidence.id)));
}
