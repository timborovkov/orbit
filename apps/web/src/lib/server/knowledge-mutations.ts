import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { validateKnowledgeUpload } from '@/lib/knowledge/extract';
import {
  KNOWLEDGE_JOB_TYPE,
  KNOWLEDGE_SEARCH_TOOL,
  type KnowledgeScope,
  maxKnowledgeBytes,
  maxKnowledgeUploadLabel,
  SHARED_KNOWLEDGE_JOB_TYPE,
} from '@/lib/knowledge/types';
import { enqueueJob } from '@/lib/queue/jobs';
import { workspaceKnowledgeIndexingConfigured } from '@/lib/runtime/knowledge/provider';
import {
  agents,
  audit,
  knowledgeDocuments,
  knowledgeLibraries,
  knowledgeLibraryGrants,
} from '@/lib/schema';
import { deleteObject, putObject, storageConfigured } from '@/lib/storage/objects';

async function requireAgent(agentId: string) {
  return (await db().select({ id: agents.id }).from(agents).where(eq(agents.id, agentId))).at(0);
}

function documentOwner(scope: KnowledgeScope) {
  return scope.kind === 'agent'
    ? eq(knowledgeDocuments.agentId, scope.id)
    : eq(knowledgeDocuments.libraryId, scope.id);
}

function scopeIds(scope: KnowledgeScope) {
  return scope.kind === 'agent' ? { agentId: scope.id } : { libraryId: scope.id };
}

function knowledgeJob(scope: KnowledgeScope, documentId: string, revision: string) {
  return {
    type: scope.kind === 'agent' ? KNOWLEDGE_JOB_TYPE : SHARED_KNOWLEDGE_JOB_TYPE,
    payload: { ...scopeIds(scope), documentId, revision },
  };
}

function documentStoragePrefix(scope: KnowledgeScope, documentId: string) {
  const directory = scope.kind === 'agent' ? 'agents' : 'knowledge-libraries';
  return `${directory}/${scope.id}/knowledge/${documentId}`;
}

async function scopeExists(scope: KnowledgeScope) {
  if (scope.kind === 'agent') return Boolean(await requireAgent(scope.id));
  const [library] = await db()
    .select({ id: knowledgeLibraries.id })
    .from(knowledgeLibraries)
    .where(eq(knowledgeLibraries.id, scope.id));
  return Boolean(library);
}

function indexingError(scope: KnowledgeScope) {
  if (scope.kind === 'library' && !workspaceKnowledgeIndexingConfigured()) {
    return { error: 'Shared knowledge indexing requires the workspace OpenRouter key.' };
  }
}

export async function insertKnowledgeLibrary(actor: string, name: string) {
  return db().transaction(async (tx) => {
    const [library] = await tx
      .insert(knowledgeLibraries)
      .values({ name })
      .onConflictDoNothing()
      .returning({ id: knowledgeLibraries.id });
    if (!library) return { error: 'A library with that name already exists.' };
    await tx.insert(audit).values({ actor, action: `Created knowledge library ${library.id}` });
    return { libraryId: library.id };
  });
}

export async function setKnowledgeLibraryGrant(
  actor: string,
  libraryId: string,
  agentId: string,
  granted: boolean,
) {
  return db().transaction(async (tx) => {
    const [library] = await tx
      .select({ id: knowledgeLibraries.id })
      .from(knowledgeLibraries)
      .where(eq(knowledgeLibraries.id, libraryId))
      .for('key share');
    if (!library) return { error: 'Knowledge library not found.' };
    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .for('key share');
    if (!agent) return { error: 'Agent not found.' };

    const changed = granted
      ? await tx
          .insert(knowledgeLibraryGrants)
          .values({ libraryId, agentId })
          .onConflictDoNothing()
          .returning({ agentId: knowledgeLibraryGrants.agentId })
      : await tx
          .delete(knowledgeLibraryGrants)
          .where(
            and(
              eq(knowledgeLibraryGrants.libraryId, libraryId),
              eq(knowledgeLibraryGrants.agentId, agentId),
            ),
          )
          .returning({ agentId: knowledgeLibraryGrants.agentId });
    if (changed.length) {
      await tx.insert(audit).values({
        actor,
        action: `${granted ? 'Granted' : 'Revoked'} knowledge library ${libraryId} access for agent ${agentId}`,
      });
    }
    return { message: granted ? 'Access granted.' : 'Access revoked.' };
  });
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
  scope: KnowledgeScope,
  file: { name: string; type: string; size: number; bytes: Uint8Array },
  source?: { citationId: string; title: string },
) {
  await requireAdmin();
  if (!(await scopeExists(scope))) return { error: 'Knowledge library or agent not found.' };
  const setupError = indexingError(scope);
  if (setupError) return setupError;
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
  const objectKey = `${documentStoragePrefix(scope, documentId)}/${file.name}`;
  try {
    await putObject(objectKey, file.bytes, validated.mimeType);
  } catch {
    return { error: 'Document storage is unavailable. Try again.' };
  }

  try {
    const saved = await db().transaction(async (tx) => {
      const insert = tx.insert(knowledgeDocuments).values({
        id: documentId,
        ...scopeIds(scope),
        filename: file.name,
        title: source?.title || titleFromFilename(file.name),
        webCitationId: source?.citationId,
        contentKind: validated.kind,
        mimeType: validated.mimeType,
        byteSize: file.bytes.byteLength,
        objectKey,
        revision,
        status: 'pending',
      });
      if (source) {
        const inserted = await insert
          .onConflictDoNothing({
            target: [knowledgeDocuments.libraryId, knowledgeDocuments.webCitationId],
          })
          .returning({ id: knowledgeDocuments.id });
        if (!inserted.length) return false;
      } else {
        await insert;
      }
      await enqueueJob(tx, {
        ...knowledgeJob(scope, documentId, revision),
        idempotencyKey: `knowledge:${documentId}:upload`,
      });
      await tx.insert(audit).values({
        actor,
        action: `Uploaded knowledge document ${documentId} for ${scope.kind} ${scope.id}`,
      });
      return true;
    });
    if (!saved) {
      await cleanupObject(objectKey, actor);
      return { message: 'This page is already in the selected library.' };
    }
  } catch {
    await cleanupObject(objectKey, actor);
    return { error: 'Unable to save the document. Try again.' };
  }

  return { message: 'Document uploaded and queued for processing.', documentId };
}

export async function replaceKnowledgeDocument(
  actor: string,
  scope: KnowledgeScope,
  documentId: string,
  file: { name: string; type: string; size: number; bytes: Uint8Array },
) {
  await requireAdmin();
  if (!(await scopeExists(scope))) return { error: 'Knowledge library or agent not found.' };
  const setupError = indexingError(scope);
  if (setupError) return setupError;
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
      .where(and(eq(knowledgeDocuments.id, documentId), documentOwner(scope)))
      .limit(1)
  ).at(0);
  if (!current) return { error: 'Document not found.' };

  const revision = randomUUID();
  // Always write under a unique key so a failed DB commit cannot delete the live object.
  const objectKey = `${documentStoragePrefix(scope, documentId)}/${revision}/${file.name}`;
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
              documentOwner(scope),
              eq(knowledgeDocuments.revision, current.revision),
            ),
          )
          .returning({ id: knowledgeDocuments.id })
      ).at(0);
      if (!updated) throw new Error('Document changed during replacement');
      await enqueueJob(tx, {
        ...knowledgeJob(scope, documentId, revision),
        idempotencyKey: `knowledge:${documentId}:replace:${revision}`,
      });
      await tx.insert(audit).values({
        actor,
        action: `Replaced knowledge document ${documentId} for ${scope.kind} ${scope.id}`,
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
  scope: KnowledgeScope,
  documentId: string,
) {
  await requireAdmin();
  const setupError = indexingError(scope);
  if (setupError) return setupError;
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
        .where(and(eq(knowledgeDocuments.id, documentId), documentOwner(scope)))
        .returning({ id: knowledgeDocuments.id })
    ).at(0);
    if (!document) return false;
    await enqueueJob(tx, {
      ...knowledgeJob(scope, documentId, revision),
      idempotencyKey: `knowledge:${documentId}:reprocess:${revision}`,
    });
    await tx.insert(audit).values({
      actor,
      action: `Reprocessed knowledge document ${documentId} for ${scope.kind} ${scope.id}`,
    });
    return true;
  });
  if (!updated) return { error: 'Document not found.' };

  return { message: 'Document queued for reprocessing.' };
}

export async function deleteKnowledgeDocument(
  actor: string,
  scope: KnowledgeScope,
  documentId: string,
) {
  await requireAdmin();
  const removed = await db().transaction(async (tx) => {
    const document = (
      await tx
        .delete(knowledgeDocuments)
        .where(and(eq(knowledgeDocuments.id, documentId), documentOwner(scope)))
        .returning({ objectKey: knowledgeDocuments.objectKey })
    ).at(0);
    if (!document) return;
    await tx.insert(audit).values({
      actor,
      action: `Deleted knowledge document ${documentId} for ${scope.kind} ${scope.id}`,
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
  await requireAdmin();
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
