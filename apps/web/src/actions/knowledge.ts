'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { isBudgetError } from '@/lib/budgets';
import { maxKnowledgeBytes, maxKnowledgeUploadLabel } from '@/lib/knowledge/types';
import { knowledgeUsesStub } from '@/lib/runtime/knowledge/embed';
import { resolveKnowledgeEmbedders } from '@/lib/runtime/knowledge/provider';
import {
  deleteKnowledgeDocument,
  inspectKnowledgeRetrieval,
  persistKnowledgeSearchAccess,
  replaceKnowledgeDocument,
  reprocessKnowledgeDocument,
  uploadKnowledgeDocument,
} from '@/lib/server/knowledge-mutations';

async function agentParams(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const agentId = z.uuid().safeParse(form.get('agentId'));
  if (!agentId.success) return { error: 'Agent not found.' as const };
  return { actor, agentId: agentId.data };
}

function readUpload(form: FormData, field = 'file') {
  const file = form.get(field);
  if (!(file instanceof File) || !file.size) return { error: 'Choose a file to upload.' as const };
  if (file.size > maxKnowledgeBytes)
    return { error: `Choose a file smaller than ${maxKnowledgeUploadLabel}.` as const };
  return { file };
}

export async function uploadKnowledge(form: FormData) {
  const parsed = await agentParams(form);
  if ('error' in parsed) return parsed;
  const upload = readUpload(form);
  if ('error' in upload) return upload;
  const bytes = new Uint8Array(await upload.file.arrayBuffer());
  const result = await uploadKnowledgeDocument(parsed.actor, parsed.agentId, {
    name: upload.file.name,
    type: upload.file.type,
    size: upload.file.size,
    bytes,
  });
  if (!('error' in result)) revalidatePath(`/agents/${parsed.agentId}`);
  return result;
}

export async function replaceKnowledge(form: FormData) {
  const parsed = await agentParams(form);
  if ('error' in parsed) return parsed;
  const documentId = z.uuid().safeParse(form.get('documentId'));
  if (!documentId.success) return { error: 'Document not found.' };
  const upload = readUpload(form);
  if ('error' in upload) return upload;
  const bytes = new Uint8Array(await upload.file.arrayBuffer());
  const result = await replaceKnowledgeDocument(parsed.actor, parsed.agentId, documentId.data, {
    name: upload.file.name,
    type: upload.file.type,
    size: upload.file.size,
    bytes,
  });
  if (!('error' in result)) revalidatePath(`/agents/${parsed.agentId}`);
  return result;
}

export async function reprocessKnowledge(form: FormData) {
  const parsed = await agentParams(form);
  if ('error' in parsed) return parsed;
  const documentId = z.uuid().safeParse(form.get('documentId'));
  if (!documentId.success) return { error: 'Document not found.' };
  const result = await reprocessKnowledgeDocument(parsed.actor, parsed.agentId, documentId.data);
  if (!('error' in result)) revalidatePath(`/agents/${parsed.agentId}`);
  return result;
}

export async function deleteKnowledge(form: FormData) {
  const parsed = await agentParams(form);
  if ('error' in parsed) return parsed;
  const documentId = z.uuid().safeParse(form.get('documentId'));
  if (!documentId.success) return { error: 'Document not found.' };
  const result = await deleteKnowledgeDocument(parsed.actor, parsed.agentId, documentId.data);
  if (!('error' in result)) revalidatePath(`/agents/${parsed.agentId}`);
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
