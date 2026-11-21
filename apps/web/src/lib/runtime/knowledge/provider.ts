import { eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import {
  knowledgeUsesStub,
  openRouterEmbedders,
  stubEmbedders,
} from '@/lib/runtime/knowledge/embed';
import { environmentOpenRouterKey, resolveOpenRouterApiKey } from '@/lib/runtime/openrouter-key';
import { credentials } from '@/lib/schema';

export async function resolveKnowledgeEmbedders(
  agentId: string,
  execution?: Parameters<typeof openRouterEmbedders>[2],
) {
  if (knowledgeUsesStub()) return stubEmbedders();
  const credential = (
    await db()
      .select({ encryptedKey: credentials.encryptedKey })
      .from(credentials)
      .where(eq(credentials.agentId, agentId))
      .limit(1)
  ).at(0);
  const { apiKey } = resolveOpenRouterApiKey(agentId, credential?.encryptedKey);
  return openRouterEmbedders(apiKey, agentId, execution);
}

export function workspaceKnowledgeIndexingConfigured() {
  return knowledgeUsesStub() || Boolean(environmentOpenRouterKey());
}

export function resolveWorkspaceKnowledgeEmbedders() {
  if (knowledgeUsesStub()) return stubEmbedders();
  const apiKey = environmentOpenRouterKey();
  if (!apiKey) throw new Error('Shared knowledge indexing requires the workspace OpenRouter key.');
  return openRouterEmbedders(apiKey, null);
}
