'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';

import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { isBudgetError } from '@/lib/budgets';
import {
  type KnowledgeScope,
  maxKnowledgeBytes,
  maxKnowledgeUploadLabel,
} from '@/lib/knowledge/types';
import { knowledgeUsesStub } from '@/lib/runtime/knowledge/embed';
import { resolveKnowledgeEmbedders } from '@/lib/runtime/knowledge/provider';
import {
  deleteKnowledgeDocument,
  insertKnowledgeLibrary,
  inspectKnowledgeRetrieval,
  persistKnowledgeSearchAccess,
  replaceKnowledgeDocument,
  reprocessKnowledgeDocument,
  setKnowledgeLibraryGrant,
  uploadKnowledgeDocument,
} from '@/lib/server/knowledge-mutations';

export async function createKnowledgeLibrary(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const name = z.string().trim().min(1).max(120).safeParse(form.get('name'));
  if (!name.success) return { error: 'Enter a name between 1 and 120 characters.' };
  const result = await insertKnowledgeLibrary(actor, name.data);
  if (!result.error) revalidatePath('/knowledge');
  return result;
}

export async function saveKnowledgeLibraryGrant(form: FormData) {
  const parsed = await agentParams(form);
  if ('error' in parsed) return parsed;
  const libraryId = z.uuid().safeParse(form.get('libraryId'));
  if (!libraryId.success) return { error: 'Knowledge library not found.' };
  const grant = form.get('granted');
  if (grant !== 'true' && grant !== 'false') return { error: 'Choose an access action.' };

  const result = await setKnowledgeLibraryGrant(
    parsed.actor,
    libraryId.data,
    parsed.agentId,
    grant === 'true',
  );
  if (!result.error) {
    revalidatePath('/knowledge');
    revalidatePath(`/knowledge/${libraryId.data}`);
    revalidatePath(`/agents/${parsed.agentId}`);
  }
  return result;
}

async function agentParams(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const agentId = z.uuid().safeParse(form.get('agentId'));
  if (!agentId.success) return { error: 'Agent not found.' as const };
  return { actor, agentId: agentId.data };
}

async function documentParams(
  form: FormData,
): Promise<{ error: string } | { actor: string; scope: KnowledgeScope }> {
  await checkOrigin();
  const actor = await requireAdmin();
  const agent = form.get('agentId');
  const library = form.get('libraryId');
  const scopeId = z.uuid().safeParse(library ?? agent);
  if (!scopeId.success || (agent !== null && library !== null)) {
    return { error: 'Knowledge library or agent not found.' as const };
  }
  const scope: KnowledgeScope = { kind: library === null ? 'agent' : 'library', id: scopeId.data };
  return { actor, scope };
}

function revalidateDocuments(scope: KnowledgeScope) {
  if (scope.kind === 'agent') {
    revalidatePath(`/agents/${scope.id}`);
  } else {
    revalidatePath('/knowledge');
    revalidatePath(`/knowledge/${scope.id}`);
    revalidatePath('/agents/[id]', 'page');
  }
}

function readUpload(form: FormData, field = 'file'): { error: string } | { file: File } {
  const file = form.get(field);
  if (!(file instanceof File) || !file.size) return { error: 'Choose a file to upload.' as const };
  if (file.size > maxKnowledgeBytes)
    return { error: `Choose a file smaller than ${maxKnowledgeUploadLabel}.` as const };
  return { file };
}

export async function uploadKnowledge(form: FormData) {
  const parsed = await documentParams(form);
  if ('error' in parsed) return parsed;
  const upload = readUpload(form);
  if ('error' in upload) return upload;
  const bytes = new Uint8Array(await upload.file.arrayBuffer());
  const result = await uploadKnowledgeDocument(parsed.actor, parsed.scope, {
    name: upload.file.name,
    type: upload.file.type,
    size: upload.file.size,
    bytes,
  });
  if (!('error' in result)) revalidateDocuments(parsed.scope);
  return result;
}

export async function replaceKnowledge(form: FormData) {
  const parsed = await documentParams(form);
  if ('error' in parsed) return parsed;
  const documentId = z.uuid().safeParse(form.get('documentId'));
  if (!documentId.success) return { error: 'Document not found.' };
  const upload = readUpload(form);
  if ('error' in upload) return upload;
  const bytes = new Uint8Array(await upload.file.arrayBuffer());
  const result = await replaceKnowledgeDocument(parsed.actor, parsed.scope, documentId.data, {
    name: upload.file.name,
    type: upload.file.type,
    size: upload.file.size,
    bytes,
  });
  if (!('error' in result)) revalidateDocuments(parsed.scope);
  return result;
}

export async function reprocessKnowledge(form: FormData) {
  const parsed = await documentParams(form);
  if ('error' in parsed) return parsed;
  const documentId = z.uuid().safeParse(form.get('documentId'));
  if (!documentId.success) return { error: 'Document not found.' };
  const result = await reprocessKnowledgeDocument(parsed.actor, parsed.scope, documentId.data);
  if (!('error' in result)) revalidateDocuments(parsed.scope);
  return result;
}

export async function deleteKnowledge(form: FormData) {
  const parsed = await documentParams(form);
  if ('error' in parsed) return parsed;
  const documentId = z.uuid().safeParse(form.get('documentId'));
  if (!documentId.success) return { error: 'Document not found.' };
  const result = await deleteKnowledgeDocument(parsed.actor, parsed.scope, documentId.data);
  if (!('error' in result)) revalidateDocuments(parsed.scope);
  return result;
}

export async function inspectKnowledge(form: FormData) {
  const parsed = await agentParams(form);
  if ('error' in parsed) return parsed;
  const query = z.string().max(2000).safeParse(form.get('query'));
  if (!query.success) return { error: 'Enter a retrieval query.' };

  try {
    const inspected = await inspectKnowledgeRetrieval(parsed.actor, parsed.agentId, query.data, {
      embedQuery: async (value, signal) => {
        const embedder = await resolveKnowledgeEmbedders(parsed.agentId);
        return embedder.embedOne(value, signal);
      },
    });
    if ('error' in inspected) return inspected;
    return {
      inspection: {
        query: inspected.result.query,
        hits: inspected.result.hits,
        embeddingMode: knowledgeUsesStub() ? ('stub' as const) : ('openrouter' as const),
        requestId: randomUUID(),
      },
    };
  } catch (error) {
    if (isBudgetError(error)) return { error: error.message };
    return {
      error: 'Unable to search the library. Check the OpenRouter connection and try again.',
    };
  }
}

export async function saveKnowledgeSearchAccess(form: FormData) {
  const parsed = await agentParams(form);
  if ('error' in parsed) return parsed;
  const enabled = form.get('enabled');
  if (enabled !== 'true' && enabled !== 'false')
    return { error: 'Choose whether to enable knowledge search.' };
  if (!(await persistKnowledgeSearchAccess(parsed.actor, parsed.agentId, enabled === 'true')))
    return { error: 'Agent not found.' };
  revalidatePath(`/agents/${parsed.agentId}`);
  return {
    message: enabled === 'true' ? 'Knowledge search enabled.' : 'Knowledge search disabled.',
  };
}
