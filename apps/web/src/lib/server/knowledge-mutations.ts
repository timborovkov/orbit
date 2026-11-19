import 'server-only';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { validateKnowledgeUpload } from '@/lib/knowledge/extract';
import {
  KNOWLEDGE_JOB_TYPE,
  KNOWLEDGE_SEARCH_TOOL,
  maxKnowledgeBytes,
  maxKnowledgeUploadLabel,
} from '@/lib/knowledge/types';
import { enqueueJob } from '@/lib/queue/jobs';
import { agents, audit, knowledgeDocuments } from '@/lib/schema';
import { deleteObject, putObject, storageConfigured } from '@/lib/storage/objects';

async function requireAgent(agentId: string) {
  return (await db().select({ id: agents.id }).from(agents).where(eq(agents.id, agentId))).at(0);
}

async function requireKnowledgeAdmin() {
  return requireAdmin();
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
  await requireKnowledgeAdmin();
  if (!(await requireAgent(agentId))) return { error: 'Agent not found.' };
  if (!storageConfigured()) {
    return {
      error: 'Document storage is not configured. Ask your administrator to connect RustFS.',
    };
  }
  if (file.bytes.byteLength > maxKnowledgeBytes || file.size > maxKnowledgeBytes) {
    return { error: `Choose a file smaller than ${maxKnowledgeUploadLabel}.` };
  }
  const validated = validateKnowledgeUpload(file);
  if ('error' in validated) return validated;

  const documentId = randomUUID();
  const revision = randomUUID();
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
        revision,
        status: 'pending',
      });
      await enqueueJob(tx, {
        type: KNOWLEDGE_JOB_TYPE,
        payload: { documentId, agentId, revision },
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
  await requireKnowledgeAdmin();
  if (!(await requireAgent(agentId))) return { error: 'Agent not found.' };
  if (!storageConfigured()) {
    return {
      error: 'Document storage is not configured. Ask your administrator to connect RustFS.',
    };
  }
  const validated = validateKnowledgeUpload(file);
  if ('error' in validated) return validated;
  if (file.bytes.byteLength > maxKnowledgeBytes) {
    return { error: `Choose a file smaller than ${maxKnowledgeUploadLabel}.` };
  }

  const current = (
    await db()
      .select()
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.agentId, agentId)))
      .limit(1)
  ).at(0);
  if (!current) return { error: 'Document not found.' };

  const revision = randomUUID();
  // Always write under a unique key so a failed DB commit cannot delete the live object.
  const objectKey = `agents/${agentId}/knowledge/${documentId}/${revision}/${file.name}`;
  try {
    await putObject(objectKey, file.bytes, validated.mimeType);
  } catch {
    return { error: 'Document storage is unavailable. Try again.' };
  }

  try {
    await db().transaction(async (tx) => {
      const updated = (
        await tx
          .update(knowledgeDocuments)
          .set({
            filename: file.name,
            title: titleFromFilename(file.name),
            contentKind: validated.kind,
            mimeType: validated.mimeType,
            byteSize: file.bytes.byteLength,
            objectKey,
            revision,
            processingToken: null,
            status: 'pending',
            error: null,
            chunkCount: 0,
            embeddedCount: 0,
            contentHash: null,
            processedAt: null,
            updatedAt: new Date(),
          })

          .where(
            and(
              eq(knowledgeDocuments.id, documentId),
              eq(knowledgeDocuments.revision, current.revision),
            ),
          )
          .returning({ id: knowledgeDocuments.id })
      ).at(0);
      if (!updated) throw new Error('Document changed during replacement');
      await enqueueJob(tx, {
        type: KNOWLEDGE_JOB_TYPE,
        payload: { documentId, agentId, revision },
        idempotencyKey: `knowledge:${documentId}:replace:${revision}`,
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
  await requireKnowledgeAdmin();
  const revision = randomUUID();
  const updated = await db().transaction(async (tx) => {
    const document = (
      await tx
        .update(knowledgeDocuments)
        .set({
          status: 'pending',
          revision,
          processingToken: null,
          error: null,
          updatedAt: new Date(),
        })
        .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.agentId, agentId)))
        .returning({ id: knowledgeDocuments.id })
    ).at(0);
    if (!document) return false;
    await enqueueJob(tx, {
      type: KNOWLEDGE_JOB_TYPE,
      payload: { documentId, agentId, revision },
      idempotencyKey: `knowledge:${documentId}:reprocess:${revision}`,
    });
    await tx.insert(audit).values({
      actor,
      action: `Reprocessed knowledge document ${documentId} for agent ${agentId}`,
    });
    return true;
  });
  if (!updated) return { error: 'Document not found.' };

  return { message: 'Document queued for reprocessing.' };
}

export async function deleteKnowledgeDocument(actor: string, agentId: string, documentId: string) {
  await requireKnowledgeAdmin();
  const removed = await db().transaction(async (tx) => {
    const document = (
      await tx
        .delete(knowledgeDocuments)
        .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.agentId, agentId)))
        .returning({ objectKey: knowledgeDocuments.objectKey })
    ).at(0);
    if (!document) return;
    await tx.insert(audit).values({
      actor,
      action: `Deleted knowledge document ${documentId} for agent ${agentId}`,
    });
    return document;
  });
  if (!removed) return { error: 'Document not found.' };
  await cleanupObject(removed.objectKey, actor);
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
  await requireKnowledgeAdmin();
  if (!(await requireAgent(agentId))) return { error: 'Agent not found.' as const };
  const trimmed = query.trim();
  if (!trimmed) return { error: 'Enter a retrieval query.' as const };
  if (trimmed.length > 2000) return { error: 'Keep the query under 2,000 characters.' as const };

  const { searchKnowledge } = await import('@/lib/runtime/knowledge/search');
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

export async function persistKnowledgeSearchAccess(
  actor: string,
  agentId: string,
  enabled: boolean,
) {
  return db().transaction(async (tx) => {
    const agent = (
      await tx
        .select({ enabledTools: agents.enabledTools })
        .from(agents)
        .where(eq(agents.id, agentId))
        .for('update')
    ).at(0);
    if (!agent) return false;
    const otherTools = agent.enabledTools.filter((tool) => tool !== KNOWLEDGE_SEARCH_TOOL);
    await tx
      .update(agents)
      .set({ enabledTools: enabled ? [...otherTools, KNOWLEDGE_SEARCH_TOOL] : otherTools })
      .where(eq(agents.id, agentId));
    await tx.insert(audit).values({
      actor,
      action: `${enabled ? 'Enabled' : 'Disabled'} knowledge search for agent ${agentId}`,
    });
    return true;
  });
}
