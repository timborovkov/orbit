import 'server-only';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { validateKnowledgeUpload } from '@/lib/knowledge/extract';
import { KNOWLEDGE_JOB_TYPE, maxKnowledgeBytes } from '@/lib/knowledge/types';
import { enqueueJob } from '@/lib/queue/jobs';
import { agents, audit, knowledgeChunks, knowledgeDocuments } from '@/lib/schema';
import { deleteObject, putObject, storageConfigured } from '@/lib/storage/objects';

async function requireAgent(agentId: string) {
  return (await db().select({ id: agents.id }).from(agents).where(eq(agents.id, agentId))).at(0);
}

async function cleanupObject(key: string, actor: string) {
  try {
    await deleteObject(key);
    return true;
  } catch {
    await db()
      .insert(audit)
      .values({ actor, action: `Knowledge storage cleanup required: ${key}` });
    return false;
  }
}

function titleFromFilename(filename: string) {
  return filename.replace(/\.[^.]+$/, '').trim() || filename;
}

export async function uploadKnowledgeDocument(
  actor: string,
  agentId: string,
  file: { name: string; type: string; size: number; bytes: Uint8Array },
) {
  if (!(await requireAgent(agentId))) return { error: 'Agent not found.' };
  if (!storageConfigured()) {
    return {
      error: 'Document storage is not configured. Ask your administrator to connect RustFS.',
    };
  }
  if (file.bytes.byteLength > maxKnowledgeBytes || file.size > maxKnowledgeBytes) {
    return { error: 'Choose a file smaller than 10 MB.' };
  }
  const validated = validateKnowledgeUpload(file);
  if ('error' in validated) return validated;

  const documentId = randomUUID();
  const objectKey = `agents/${agentId}/knowledge/${documentId}/${file.name}`;
  try {
    await putObject(objectKey, file.bytes, validated.mimeType);
  } catch {
    return { error: 'Document storage is unavailable. Try again.' };
  }

  try {
    await db().transaction(async (tx) => {
      await tx.insert(knowledgeDocuments).values({
        id: documentId,
        agentId,
        filename: file.name,
        title: titleFromFilename(file.name),
        contentKind: validated.kind,
        mimeType: validated.mimeType,
        byteSize: file.bytes.byteLength,
        objectKey,
        status: 'pending',
      });
      await enqueueJob(tx, {
        type: KNOWLEDGE_JOB_TYPE,
        payload: { documentId, agentId },
        idempotencyKey: `knowledge:${documentId}:upload`,
      });
      await tx.insert(audit).values({
        actor,
        action: `Uploaded knowledge document ${documentId} for agent ${agentId}`,
      });
    });
  } catch {
    await cleanupObject(objectKey, actor);
    return { error: 'Unable to save the document. Try again.' };
  }

  return { message: 'Document uploaded and queued for processing.', documentId };
}

export async function replaceKnowledgeDocument(
  actor: string,
  agentId: string,
  documentId: string,
  file: { name: string; type: string; size: number; bytes: Uint8Array },
) {
  if (!(await requireAgent(agentId))) return { error: 'Agent not found.' };
  if (!storageConfigured()) {
    return {
      error: 'Document storage is not configured. Ask your administrator to connect RustFS.',
    };
  }
  const validated = validateKnowledgeUpload(file);
  if ('error' in validated) return validated;
  if (file.bytes.byteLength > maxKnowledgeBytes) {
    return { error: 'Choose a file smaller than 10 MB.' };
  }

  const current = (
    await db()
      .select()
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.agentId, agentId)))
      .limit(1)
  ).at(0);
  if (!current) return { error: 'Document not found.' };

  const objectKey = `agents/${agentId}/knowledge/${documentId}/${file.name}`;
  try {
    await putObject(objectKey, file.bytes, validated.mimeType);
  } catch {
    return { error: 'Document storage is unavailable. Try again.' };
  }

  try {
    await db().transaction(async (tx) => {
      await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, documentId));
      await tx
        .update(knowledgeDocuments)
        .set({
          filename: file.name,
          title: titleFromFilename(file.name),
          contentKind: validated.kind,
          mimeType: validated.mimeType,
          byteSize: file.bytes.byteLength,
          objectKey,
          status: 'pending',
          error: null,
          chunkCount: 0,
          embeddedCount: 0,
          contentHash: null,
          processedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeDocuments.id, documentId));
      await enqueueJob(tx, {
        type: KNOWLEDGE_JOB_TYPE,
        payload: { documentId, agentId },
        idempotencyKey: `knowledge:${documentId}:replace:${Date.now()}`,
      });
      await tx.insert(audit).values({
        actor,
        action: `Replaced knowledge document ${documentId} for agent ${agentId}`,
      });
    });
  } catch {
    await cleanupObject(objectKey, actor);
    return { error: 'Unable to replace the document. Try again.' };
  }

  if (current.objectKey !== objectKey) await cleanupObject(current.objectKey, actor);
  return { message: 'Document replaced and queued for processing.' };
}

export async function reprocessKnowledgeDocument(
  actor: string,
  agentId: string,
  documentId: string,
) {
  const current = (
    await db()
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.agentId, agentId)))
      .limit(1)
  ).at(0);
  if (!current) return { error: 'Document not found.' };

  await db().transaction(async (tx) => {
    await tx
      .update(knowledgeDocuments)
      .set({
        status: 'pending',
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(knowledgeDocuments.id, documentId));
    await enqueueJob(tx, {
      type: KNOWLEDGE_JOB_TYPE,
      payload: { documentId, agentId },
      idempotencyKey: `knowledge:${documentId}:reprocess:${Date.now()}`,
    });
    await tx.insert(audit).values({
      actor,
      action: `Reprocessed knowledge document ${documentId} for agent ${agentId}`,
    });
  });

  return { message: 'Document queued for reprocessing.' };
}

export async function deleteKnowledgeDocument(actor: string, agentId: string, documentId: string) {
  const current = (
    await db()
      .select()
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.agentId, agentId)))
      .limit(1)
  ).at(0);
  if (!current) return { error: 'Document not found.' };

  await db().transaction(async (tx) => {
    await tx.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, documentId));
    await tx.insert(audit).values({
      actor,
      action: `Deleted knowledge document ${documentId} for agent ${agentId}`,
    });
  });
  await cleanupObject(current.objectKey, actor);
  return { message: 'Document deleted.' };
}

export async function inspectKnowledgeRetrieval(
  actor: string,
  agentId: string,
  query: string,
  options: {
    embedQuery: (value: string, signal?: AbortSignal) => Promise<number[]>;
    limit?: number;
  },
) {
  if (!(await requireAgent(agentId))) return { error: 'Agent not found.' as const };
  const trimmed = query.trim();
  if (!trimmed) return { error: 'Enter a retrieval query.' as const };
  if (trimmed.length > 2000) return { error: 'Keep the query under 2,000 characters.' as const };

  const { searchKnowledge } = await import('@/lib/knowledge/search');
  const result = await searchKnowledge({
    agentId,
    query: trimmed,
    limit: options.limit ?? 8,
    embedQuery: options.embedQuery,
  });

  await db()
    .insert(audit)
    .values({
      actor,
      action: `Inspected knowledge retrieval for agent ${agentId}`,
    });

  return { result };
}
