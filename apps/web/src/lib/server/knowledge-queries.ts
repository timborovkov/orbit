import 'server-only';

import { asc, count, desc, eq, sql } from 'drizzle-orm';

import { getAdminEmail, requireAdmin } from '@/lib/auth';
import { db, sqlClient } from '@/lib/db';
import type { KnowledgeScope } from '@/lib/knowledge/types';
import { knowledgeVisibleToAgent } from '@/lib/runtime/knowledge/access';
import {
  agents,
  knowledgeDocuments,
  knowledgeLibraries,
  knowledgeLibraryGrants,
} from '@/lib/schema';

function documentsFor(scope: KnowledgeScope) {
  return db()
    .select({
      id: knowledgeDocuments.id,
      filename: knowledgeDocuments.filename,
      title: knowledgeDocuments.title,
      contentKind: knowledgeDocuments.contentKind,
      mimeType: knowledgeDocuments.mimeType,
      byteSize: knowledgeDocuments.byteSize,
      status: knowledgeDocuments.status,
      error: knowledgeDocuments.error,
      chunkCount: knowledgeDocuments.chunkCount,
      embeddedCount: knowledgeDocuments.embeddedCount,
      createdAt: knowledgeDocuments.createdAt,
      updatedAt: knowledgeDocuments.updatedAt,
      processedAt: knowledgeDocuments.processedAt,
    })
    .from(knowledgeDocuments)
    .where(
      scope.kind === 'agent'
        ? eq(knowledgeDocuments.agentId, scope.id)
        : eq(knowledgeDocuments.libraryId, scope.id),
    )
    .orderBy(desc(knowledgeDocuments.createdAt));
}

export async function listKnowledgeDocuments(agentId: string) {
  await requireAdmin();
  return documentsFor({ kind: 'agent', id: agentId });
}

export async function listKnowledgeLibraries() {
  const email = await requireAdmin();
  const items = await db()
    .select({
      id: knowledgeLibraries.id,
      name: knowledgeLibraries.name,
      documentCount: sql<number>`(
        SELECT count(*)::int FROM knowledge_documents WHERE library_id = ${knowledgeLibraries}.id
      )`,
      agentCount: sql<number>`(
        SELECT count(*)::int FROM knowledge_library_grants WHERE library_id = ${knowledgeLibraries}.id
      )`,
    })
    .from(knowledgeLibraries)
    .orderBy(asc(knowledgeLibraries.name), asc(knowledgeLibraries.id));
  return { email, items };
}

export async function getKnowledgeLibrary(libraryId: string) {
  const email = await requireAdmin();
  const [library] = await db()
    .select()
    .from(knowledgeLibraries)
    .where(eq(knowledgeLibraries.id, libraryId));
  if (!library) return null;

  const [documents, agentAccess] = await Promise.all([
    documentsFor({ kind: 'library', id: libraryId }),
    db()
      .select({
        id: agents.id,
        name: agents.name,
        granted: sql<boolean>`EXISTS (
          SELECT 1 FROM knowledge_library_grants AS membership
          WHERE membership.library_id = ${libraryId} AND membership.agent_id = ${agents}.id
        )`,
      })
      .from(agents)
      .orderBy(asc(agents.name), asc(agents.id)),
  ]);
  return { email, library, documents, agentAccess };
}

export async function listGrantedKnowledgeLibraries(agentId: string) {
  await requireAdmin();
  return db()
    .select({
      id: knowledgeLibraries.id,
      name: knowledgeLibraries.name,
      documentCount: count(knowledgeDocuments.id),
      readyCount:
        sql<number>`count(*) FILTER (WHERE ${knowledgeDocuments.status} = 'ready')`.mapWith(Number),
      pendingCount: sql<number>`count(*) FILTER (
        WHERE ${knowledgeDocuments.status} IN ('pending', 'processing')
      )`.mapWith(Number),
      updatedAt: sql<string | null>`max(${knowledgeDocuments.updatedAt})::text`,
    })
    .from(knowledgeLibraryGrants)
    .innerJoin(knowledgeLibraries, eq(knowledgeLibraryGrants.libraryId, knowledgeLibraries.id))
    .leftJoin(knowledgeDocuments, eq(knowledgeDocuments.libraryId, knowledgeLibraries.id))
    .where(eq(knowledgeLibraryGrants.agentId, agentId))
    .groupBy(knowledgeLibraries.id)
    .orderBy(asc(knowledgeLibraries.name), asc(knowledgeLibraries.id));
}

export async function getKnowledgeSource(agentId: string, documentId: string) {
  if (!(await getAdminEmail())) return null;
  const client = sqlClient();
  const [source] = await client<{ objectKey: string; filename: string; mimeType: string }[]>`
    SELECT object_key AS "objectKey", filename, mime_type AS "mimeType"
    FROM knowledge_documents AS document
    WHERE document.id = ${documentId} AND ${knowledgeVisibleToAgent(client, agentId)}
  `;
  return source ?? null;
}
