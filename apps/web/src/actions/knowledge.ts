'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { openRouterEmbedders, stubEmbedders } from '@/lib/knowledge/embed';
import { maxKnowledgeBytes } from '@/lib/knowledge/types';
import { resolveOpenRouterApiKey } from '@/lib/runtime/openrouter-key';
import { credentials } from '@/lib/schema';
import {
  deleteKnowledgeDocument,
  inspectKnowledgeRetrieval,
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
  if (file.size > maxKnowledgeBytes) return { error: 'Choose a file smaller than 10 MB.' as const };
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

  let embedQuery: (value: string, signal?: AbortSignal) => Promise<number[]>;
  try {
    const credential = (
      await db()
        .select({ encryptedKey: credentials.encryptedKey })
        .from(credentials)
        .where(eq(credentials.agentId, parsed.agentId))
        .limit(1)
    ).at(0);
    const { apiKey } = resolveOpenRouterApiKey(parsed.agentId, credential?.encryptedKey);
    embedQuery = openRouterEmbedders(apiKey).embedOne;
  } catch {
    if (process.env.NODE_ENV === 'development' && process.env.KNOWLEDGE_EMBEDDING_STUB === 'true') {
      embedQuery = stubEmbedders().embedOne;
    } else {
      return {
        error:
          'OpenRouter is not connected for this agent. Add an agent key under Access or set OPENROUTER_API_KEY.',
      };
    }
  }

  const inspected = await inspectKnowledgeRetrieval(parsed.actor, parsed.agentId, query.data, {
    embedQuery,
  });
  if ('error' in inspected) return inspected;
  return {
    message: inspected.result.hits.length
      ? `Found ${inspected.result.hits.length} passage${inspected.result.hits.length === 1 ? '' : 's'}.`
      : 'No matching passages yet.',
    inspection: {
      query: inspected.result.query,
      hits: inspected.result.hits,
      requestId: randomUUID(),
    },
  };
}
