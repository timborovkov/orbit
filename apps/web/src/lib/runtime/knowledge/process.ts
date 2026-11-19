import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { isBudgetError } from '@/lib/budgets';
import { db, type Tx } from '@/lib/db';
import { chunkExtractedText } from '@/lib/knowledge/chunk';
import { extractKnowledgeDocument } from '@/lib/knowledge/extract';
import { KNOWLEDGE_CHUNK_INSERT_BATCH, KNOWLEDGE_JOB_TYPE } from '@/lib/knowledge/types';
import {
  knowledgeEmbeddingDimensions,
  knowledgeEmbeddingModelId,
  knowledgeEmbeddingReuseKey,
  validateKnowledgeVector,
  type EmbedManyFn,
} from '@/lib/runtime/knowledge/embed';
import { knowledgeChunks, knowledgeDocuments } from '@/lib/schema';
import { getObject } from '@/lib/storage/objects';

function jobDocument(payload: Record<string, unknown>) {
  const { documentId, agentId, revision } = payload;
  if (typeof documentId !== 'string' || typeof agentId !== 'string' || typeof revision !== 'string')
    return;
  return and(
    eq(knowledgeDocuments.id, documentId),
    eq(knowledgeDocuments.agentId, agentId),
    eq(knowledgeDocuments.revision, revision),
  );
}

/** Only the current processor can commit chunks or publish this revision. */
export async function processKnowledgeDocument(
  payload: Record<string, unknown>,
  embedMany: EmbedManyFn,
  signal?: AbortSignal,
) {
  const target = jobDocument(payload);
  if (!target) return;
  signal?.throwIfAborted();
  const token = randomUUID();
  const document = (
    await db()
      .update(knowledgeDocuments)
      .set({ status: 'processing', processingToken: token, error: null, updatedAt: new Date() })
      .where(and(target, inArray(knowledgeDocuments.status, ['pending', 'processing', 'failed'])))
      .returning()
  ).at(0);
  if (!document) return;
  const owned = and(target, eq(knowledgeDocuments.processingToken, token));
  const documentChunks = eq(knowledgeChunks.documentId, document.id);

  function commit(write: (tx: Tx) => Promise<void>) {
    return db().transaction(async (tx) => {
      signal?.throwIfAborted();
      const locked = (
        await tx
          .select({ id: knowledgeDocuments.id })
          .from(knowledgeDocuments)
          .where(owned)
          .for('update')
      ).at(0);
      if (!locked) return false;
      await write(tx);
      signal?.throwIfAborted();
      return true;
    });
  }

  try {
    const object = await getObject(document.objectKey);
    if (!object?.body.length) throw new Error('Document object is missing from storage');
    const extracted = await extractKnowledgeDocument(object.body, document.contentKind);
    const drafts = chunkExtractedText({
      text: extracted.text,
      kind: document.contentKind,
      filename: document.filename,
      title: document.title,
      sections: extracted.sections,
    });
    if (!drafts.length) throw new Error('No searchable chunks were produced from this document');
    const model = knowledgeEmbeddingModelId();
    const dimensions = knowledgeEmbeddingDimensions();
    const pending: { id: string; content: string }[] = [];
    let embeddedCount = 0;

    if (
      !(await commit(async (tx) => {
        const existing = await tx
          .select({
            chunkIndex: knowledgeChunks.chunkIndex,
            contentHash: knowledgeChunks.contentHash,
            embedding: knowledgeChunks.embedding,
            embeddingModel: knowledgeChunks.embeddingModel,
            embeddingDimensions: knowledgeChunks.embeddingDimensions,
          })
          .from(knowledgeChunks)
          .where(documentChunks);
        const reusable = new Map<string, number[]>();
        for (const row of existing) {
          if (
            row.embedding &&
            row.embeddingModel === model &&
            row.embeddingDimensions === dimensions
          ) {
            reusable.set(
              knowledgeEmbeddingReuseKey(row.chunkIndex, row.contentHash, model, dimensions),
              row.embedding,
            );
          }
        }
        const rows = drafts.map((draft) => {
          const embedding =
            reusable.get(
              knowledgeEmbeddingReuseKey(draft.index, draft.contentHash, model, dimensions),
            ) ?? null;
          const id = randomUUID();
          if (embedding) embeddedCount += 1;
          else pending.push({ id, content: draft.content });
          return {
            id,
            documentId: document.id,
            agentId: document.agentId,
            chunkIndex: draft.index,
            content: draft.content,
            contentHash: draft.contentHash,
            sourceFilename: draft.filename,
            sourceTitle: draft.title,
            page: draft.page ?? null,
            section: draft.section ?? null,
            startOffset: draft.startOffset,
            endOffset: draft.endOffset,
            embedding,
            embeddingModel: embedding ? model : null,
            embeddingDimensions: embedding ? dimensions : null,
          };
        });
        await tx.delete(knowledgeChunks).where(documentChunks);
        const batches = Array.from(
          { length: Math.ceil(rows.length / KNOWLEDGE_CHUNK_INSERT_BATCH) },
          (_, index) =>
            rows.slice(
              index * KNOWLEDGE_CHUNK_INSERT_BATCH,
              (index + 1) * KNOWLEDGE_CHUNK_INSERT_BATCH,
            ),
        );
        // Keep each insert below PostgreSQL's bind limit in the same transaction.
        await batches.reduce<Promise<void>>(
          (previous, batch) =>
            previous.then(() => tx.insert(knowledgeChunks).values(batch)).then(() => undefined),
          Promise.resolve(),
        );
        await tx
          .update(knowledgeDocuments)
          .set({
            contentHash: extracted.contentHash,
            chunkCount: rows.length,
            embeddedCount,
            updatedAt: new Date(),
          })
          .where(owned);
      }))
    )
      return;

    const batchSize = 32;
    const batches = Array.from({ length: Math.ceil(pending.length / batchSize) }, (_, index) =>
      pending.slice(index * batchSize, (index + 1) * batchSize),
    );
    // Commit each batch before spending quota on the next so retries can reuse saved vectors.
    const completed = await batches.reduce(
      (previous, batch) =>
        previous.then(async (current) => {
          if (!current) return false;
          signal?.throwIfAborted();
          const stillOwned = (
            await db().select({ id: knowledgeDocuments.id }).from(knowledgeDocuments).where(owned)
          ).at(0);
          if (!stillOwned) return false;
          const embeddings = await embedMany(
            batch.map((row) => row.content),
            signal,
          );
          if (embeddings.length !== batch.length) {
            throw new Error('Embedding provider returned an unexpected batch size');
          }
          const vectors = embeddings.map((vector) => validateKnowledgeVector(vector, dimensions));
          return commit(async (tx) => {
            await Promise.all(
              batch.map((row, i) =>
                tx
                  .update(knowledgeChunks)
                  .set({
                    embedding: vectors[i],
                    embeddingModel: model,
                    embeddingDimensions: dimensions,
                  })
                  .where(eq(knowledgeChunks.id, row.id)),
              ),
            );
            embeddedCount += batch.length;
            await tx
              .update(knowledgeDocuments)
              .set({ embeddedCount, updatedAt: new Date() })
              .where(owned);
          });
        }),
      Promise.resolve(true),
    );
    if (!completed) return;

    await commit(async (tx) => {
      const now = new Date();
      await tx
        .update(knowledgeDocuments)
        .set({
          status: 'ready',
          processingToken: null,
          error: null,
          processedAt: now,
          updatedAt: now,
        })
        .where(owned);
    });
  } catch (error) {
    if (!signal?.aborted) {
      const message = isBudgetError(error)
        ? error.message
        : 'Unable to process the document. Check the file and the agent’s OpenRouter connection.';
      await db()
        .update(knowledgeDocuments)
        .set({
          status: 'failed',
          processingToken: null,
          error: message.slice(0, 2000),
          updatedAt: new Date(),
        })
        .where(owned);
    }
    throw error;
  }
}

export async function finalizeFailedKnowledgeJob(payload: Record<string, unknown>, reason: string) {
  const target = jobDocument(payload);
  if (!target) return;
  const now = new Date();
  await db()
    .update(knowledgeDocuments)
    .set({
      status: 'failed',
      processingToken: null,
      error: reason.slice(0, 2000),
      updatedAt: now,
      processedAt: now,
    })
    .where(and(target, inArray(knowledgeDocuments.status, ['pending', 'processing'])));
}

/** Recover if the worker died after dead-lettering but before updating the document. */
export async function reconcileDeadKnowledgeJobs() {
  await db().execute(sql`
    UPDATE knowledge_documents AS document
    SET status = 'failed', processing_token = NULL,
        error = 'The worker could not finish processing the document.',
        updated_at = now(), processed_at = now()
    WHERE document.status IN ('pending', 'processing')
      AND EXISTS (
        SELECT 1 FROM jobs
        WHERE type = ${KNOWLEDGE_JOB_TYPE} AND status = 'dead'
          AND payload->>'documentId' = document.id::text
          AND payload->>'agentId' = document.agent_id::text
          AND payload->>'revision' = document.revision::text
      )
  `);
}
