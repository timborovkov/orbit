import 'server-only';

import { and, desc, eq } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { agentMemories, runMemoryEvidence } from '@/lib/schema';

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
      correctedBy: agentMemories.correctedBy,
      source: {
        id: runMemoryEvidence.sourceId,
        title: runMemoryEvidence.title,
        author: runMemoryEvidence.author,
        body: runMemoryEvidence.body,
        label: runMemoryEvidence.label,
        href: runMemoryEvidence.href,
        linkLabel: runMemoryEvidence.linkLabel,
      },
    })
    .from(agentMemories)
    .innerJoin(
      runMemoryEvidence,
      and(
        eq(runMemoryEvidence.sourceId, agentMemories.sourceId),
        eq(runMemoryEvidence.sourceKind, agentMemories.sourceKind),
        eq(runMemoryEvidence.agentId, agentMemories.agentId),
        eq(runMemoryEvidence.runId, agentMemories.runId),
      ),
    )
    .where(
      and(
        eq(agentMemories.agentId, agentId),
        eq(agentMemories.id, entryId),
        eq(agentMemories.revision, revision),
      ),
    );
  return row ?? null;
}
