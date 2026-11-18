import 'server-only';

import { desc, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { knowledgeDocuments } from '@/lib/schema';

export async function listKnowledgeDocuments(agentId: string) {
  const rows = await db()
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
    .where(eq(knowledgeDocuments.agentId, agentId))
    .orderBy(desc(knowledgeDocuments.createdAt));
  return rows;
}
