import 'server-only';

import { and, desc, eq } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { agentMemories, agentMemoryEvidenceVersions, runMemoryEvidence } from '@/lib/schema';

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
      subject: agentMemoryEvidenceVersions.subject,
      topic: agentMemoryEvidenceVersions.topic,
      quote: agentMemoryEvidenceVersions.quote,
      sourceAt: agentMemoryEvidenceVersions.sourceAt,
      correctedBy: agentMemoryEvidenceVersions.correctedBy,
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
    .from(agentMemoryEvidenceVersions)
    .innerJoin(
      runMemoryEvidence,
      and(
        eq(runMemoryEvidence.sourceId, agentMemoryEvidenceVersions.sourceId),
        eq(runMemoryEvidence.sourceKind, agentMemoryEvidenceVersions.sourceKind),
        eq(runMemoryEvidence.agentId, agentMemoryEvidenceVersions.agentId),
        eq(runMemoryEvidence.runId, agentMemoryEvidenceVersions.runId),
      ),
    )
    .where(
      and(
        eq(agentMemoryEvidenceVersions.agentId, agentId),
        eq(agentMemoryEvidenceVersions.id, entryId),
        eq(agentMemoryEvidenceVersions.revision, revision),
      ),
    );
  return row ?? null;
}
