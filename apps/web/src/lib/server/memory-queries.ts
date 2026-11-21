import 'server-only';

import { and, desc, eq, sql } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { agentMemories, emailMessages, sourceEvents } from '@/lib/schema';

const pageSize = 30;

export async function listAgentMemories(agentId: string, page: number) {
  await requireAdmin();
  const rows = await db()
    .select({
      id: agentMemories.id,
      revision: agentMemories.revision,
      subject: agentMemories.subject,
      topic: agentMemories.topic,
      fact: agentMemories.fact,
      learnedAt: agentMemories.learnedAt,
      expiresOn: agentMemories.expiresOn,
      reviewOn: agentMemories.reviewOn,
      correctedBy: agentMemories.correctedBy,
      correctedAt: agentMemories.correctedAt,
      fromEmail: sql<boolean>`${agentMemories.emailMessageId} IS NOT NULL`,
    })
    .from(agentMemories)
    .where(eq(agentMemories.agentId, agentId))
    .orderBy(desc(agentMemories.learnedAt), desc(agentMemories.id))
    .limit(pageSize + 1)
    .offset((page - 1) * pageSize);
  return { rows: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}

export async function getAgentMemoryEvidence(agentId: string, entryId: string, revision: string) {
  await requireAdmin();
  return selectAgentMemoryEvidence(agentId, entryId, revision);
}

/** Shared with integration coverage. Its only web entry point checks the admin session. */
export async function selectAgentMemoryEvidence(
  agentId: string,
  entryId: string,
  revision: string,
) {
  const [row] = await db()
    .select({
      subject: agentMemories.subject,
      topic: agentMemories.topic,
      quote: agentMemories.quote,
      sourceAt: agentMemories.sourceAt,
      runId: agentMemories.runId,
      correctedBy: agentMemories.correctedBy,
      email: {
        id: emailMessages.id,
        threadId: emailMessages.threadId,
        subject: emailMessages.subject,
        sender: emailMessages.sender,
        body: emailMessages.body,
      },
      event: {
        id: sourceEvents.id,
        author: sourceEvents.authorUsername,
        text: sourceEvents.text,
      },
    })
    .from(agentMemories)
    .leftJoin(
      emailMessages,
      and(
        eq(emailMessages.id, agentMemories.emailMessageId),
        eq(emailMessages.agentId, agentMemories.agentId),
        eq(emailMessages.runId, agentMemories.runId),
      ),
    )
    .leftJoin(
      sourceEvents,
      and(
        eq(sourceEvents.id, agentMemories.sourceEventId),
        eq(sourceEvents.agentId, agentMemories.agentId),
        eq(sourceEvents.runId, agentMemories.runId),
      ),
    )
    .where(
      and(
        eq(agentMemories.agentId, agentId),
        eq(agentMemories.id, entryId),
        eq(agentMemories.revision, revision),
      ),
    );
  return typeof row?.email?.body === 'string' || row?.event ? row : null;
}
