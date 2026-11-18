import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import { chunkExtractedText } from '@/lib/knowledge/chunk';
import type { EmbedManyFn } from '@/lib/knowledge/embed';
import { extractKnowledgeDocument } from '@/lib/knowledge/extract';
import { KNOWLEDGE_JOB_TYPE } from '@/lib/knowledge/types';
import { knowledgeChunks, knowledgeDocuments } from '@/lib/schema';
import { getObject } from '@/lib/storage/objects';

export { KNOWLEDGE_JOB_TYPE };

function vectorLiteral(values: number[]) {
  return `[${values.join(',')}]`;
}

async function markFailed(documentId: string, agentId: string, error: string) {
  const now = new Date();
  await db()
    .update(knowledgeDocuments)
    .set({
      status: 'failed',
      error: error.slice(0, 2000),
      updatedAt: now,
      processedAt: now,
    })
    .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.agentId, agentId)));
}

/**
 * Extract → chunk → embed pipeline. Embeddings already stored for unchanged chunk
 * hashes are reused so retries do not re-pay OpenRouter for completed vectors.
 */
export async function processKnowledgeDocument(
  payload: Record<string, unknown>,
  embedMany: EmbedManyFn,
  signal?: AbortSignal,
) {
  const documentId = typeof payload.documentId === 'string' ? payload.documentId : null;
  const agentId = typeof payload.agentId === 'string' ? payload.agentId : null;
  if (!documentId || !agentId) throw new Error('Knowledge job payload is incomplete');

  const document = (
    await db()
      .select()
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.agentId, agentId)))
      .limit(1)
  ).at(0);
  if (!document) return;

  if (signal?.aborted) throw new Error('Knowledge processing aborted');

  await db()
    .update(knowledgeDocuments)
    .set({ status: 'processing', error: null, updatedAt: new Date() })
    .where(eq(knowledgeDocuments.id, documentId));

  try {
    const object = await getObject(document.objectKey);
    if (!object?.body.length) throw new Error('Document object is missing from storage');

    const extracted = await extractKnowledgeDocument(object.body, document.contentKind);
    if (signal?.aborted) throw new Error('Knowledge processing aborted');

    const drafts = chunkExtractedText({
      text: extracted.text,
      kind: document.contentKind,
      filename: document.filename,
      title: document.title,
      sections: extracted.sections,
    });
    if (!drafts.length) throw new Error('No searchable chunks were produced from this document');

    const existing = await db()
      .select({
        chunkIndex: knowledgeChunks.chunkIndex,
        contentHash: knowledgeChunks.contentHash,
        embedding: knowledgeChunks.embedding,
      })
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.documentId, documentId));
    const reusable = new Map<string, number[]>();
    for (const row of existing) {
      if (row.embedding) reusable.set(`${row.chunkIndex}:${row.contentHash}`, row.embedding);
    }

    await db().transaction(async (tx) => {
      await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, documentId));
      await tx.insert(knowledgeChunks).values(
        drafts.map((draft) => ({
          documentId,
          agentId,
          chunkIndex: draft.index,
          content: draft.content,
          contentHash: draft.contentHash,
          sourceFilename: draft.filename,
          sourceTitle: draft.title,
          page: draft.page ?? null,
          section: draft.section ?? null,
          startOffset: draft.startOffset,
          endOffset: draft.endOffset,
          embedding: reusable.get(`${draft.index}:${draft.contentHash}`) ?? null,
        })),
      );
      await tx
        .update(knowledgeDocuments)
        .set({
          contentHash: extracted.contentHash,
          chunkCount: drafts.length,
          embeddedCount: drafts.filter((draft) =>
            reusable.has(`${draft.index}:${draft.contentHash}`),
          ).length,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeDocuments.id, documentId));
    });

    const pending = await db()
      .select({
        id: knowledgeChunks.id,
        content: knowledgeChunks.content,
      })
      .from(knowledgeChunks)
      .where(and(eq(knowledgeChunks.documentId, documentId), isNull(knowledgeChunks.embedding)))
      .orderBy(knowledgeChunks.chunkIndex);

    const batchSize = 32;
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      if (signal?.aborted) throw new Error('Knowledge processing aborted');
      const batch = pending.slice(offset, offset + batchSize);
      const embeddings = await embedMany(
        batch.map((row) => row.content),
        signal,
      );
      if (embeddings.length !== batch.length) {
        throw new Error('Embedding provider returned an unexpected batch size');
      }
      await Promise.all(
        batch.map(async (row, i) => {
          const embedding = embeddings.at(i);
          if (!embedding) throw new Error('Embedding provider returned an unexpected batch size');
          await db().execute(sql`
            UPDATE knowledge_chunks
            SET embedding = ${vectorLiteral(embedding)}::vector
            WHERE id = ${row.id}
          `);
        }),
      );
      const embedded = (
        await db()
          .select({ count: sql<number>`count(*)::int` })
          .from(knowledgeChunks)
          .where(
            and(eq(knowledgeChunks.documentId, documentId), isNotNull(knowledgeChunks.embedding)),
          )
      ).at(0)?.count;
      await db()
        .update(knowledgeDocuments)
        .set({
          embeddedCount: embedded ?? 0,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeDocuments.id, documentId));
    }

    const now = new Date();
    const finalEmbedded = (
      await db()
        .select({ count: sql<number>`count(*)::int` })
        .from(knowledgeChunks)
        .where(
          and(eq(knowledgeChunks.documentId, documentId), isNotNull(knowledgeChunks.embedding)),
        )
    ).at(0)?.count;
    await db()
      .update(knowledgeDocuments)
      .set({
        status: 'ready',
        error: null,
        embeddedCount: finalEmbedded ?? 0,
        chunkCount: drafts.length,
        contentHash: extracted.contentHash,
        processedAt: now,
        updatedAt: now,
      })
      .where(eq(knowledgeDocuments.id, documentId));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Knowledge document processing failed';
    await markFailed(documentId, agentId, message);
    throw error;
  }
}

export async function finalizeFailedKnowledgeJob(payload: Record<string, unknown>, reason: string) {
  const documentId = typeof payload.documentId === 'string' ? payload.documentId : null;
  const agentId = typeof payload.agentId === 'string' ? payload.agentId : null;
  if (!documentId || !agentId) return;
  await markFailed(documentId, agentId, reason);
}
