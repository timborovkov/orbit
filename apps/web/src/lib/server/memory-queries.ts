import 'server-only';

import { and, desc, eq, sql } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { agentMemories, memoryEvidence, personMemoryEvidence } from '@/lib/schema';

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
      personField: agentMemories.personField,
      personValue: agentMemories.personValue,
      noteKind: sql<string | null>`${agentMemories.note}->>'kind'`,
      personId: personMemoryEvidence.personId,
      learnedAt: agentMemories.learnedAt,
      expiresOn: agentMemories.expiresOn,
      reviewOn: agentMemories.reviewOn,
      correctedBy: agentMemories.correctedBy,
      correctedAt: agentMemories.correctedAt,
    })
    .from(agentMemories)
    .leftJoin(
      personMemoryEvidence,
      and(
        eq(personMemoryEvidence.memoryId, agentMemories.id),
        eq(personMemoryEvidence.agentId, agentMemories.agentId),
      ),
    )
    .where(eq(agentMemories.agentId, agentId))
    .orderBy(desc(agentMemories.learnedAt), desc(agentMemories.id))
    .limit(pageSize + 1)
    .offset((page - 1) * pageSize);
  return { rows: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}

/** The People query checks the admin session and chooses the agent scope. */
export function selectPersonMemories(agentId: string, personId: string) {
  return db()
    .select({
      id: agentMemories.id,
      revision: agentMemories.revision,
      topic: agentMemories.topic,
      value: agentMemories.personValue,
    })
    .from(personMemoryEvidence)
    .innerJoin(
      agentMemories,
      and(
        eq(agentMemories.id, personMemoryEvidence.memoryId),
        eq(agentMemories.agentId, personMemoryEvidence.agentId),
      ),
    )
    .where(
      and(
        eq(personMemoryEvidence.agentId, agentId),
        eq(personMemoryEvidence.personId, personId),
        sql`(${agentMemories.expiresOn} IS NULL OR ${agentMemories.expiresOn} > (now() AT TIME ZONE 'UTC')::date)`,
      ),
    )
    .orderBy(desc(agentMemories.learnedAt), desc(agentMemories.id))
    .limit(pageSize);
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
        id: memoryEvidence.sourceId,
        title: memoryEvidence.title,
        author: memoryEvidence.author,
        body: memoryEvidence.body,
        label: memoryEvidence.label,
        href: memoryEvidence.href,
        linkLabel: memoryEvidence.linkLabel,
      },
    })
    .from(agentMemories)
    .innerJoin(
      memoryEvidence,
      and(
        eq(memoryEvidence.sourceId, agentMemories.sourceId),
        eq(memoryEvidence.sourceKind, agentMemories.sourceKind),
        eq(memoryEvidence.agentId, agentMemories.agentId),
        eq(memoryEvidence.runId, agentMemories.runId),
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
