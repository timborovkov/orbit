import { eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { openRouterEmbedders, stubEmbedders, type EmbedManyFn } from '@/lib/knowledge/embed';
import {
  finalizeFailedKnowledgeJob,
  KNOWLEDGE_JOB_TYPE,
  processKnowledgeDocument,
} from '@/lib/knowledge/process';
import { resolveOpenRouterApiKey } from '@/lib/runtime/openrouter-key';
import { credentials } from '@/lib/schema';

export { finalizeFailedKnowledgeJob, KNOWLEDGE_JOB_TYPE, processKnowledgeDocument };

export async function resolveKnowledgeEmbedder(agentId: string): Promise<EmbedManyFn> {
  if (process.env.KNOWLEDGE_EMBEDDING_STUB === 'true') {
    return stubEmbedders().embedMany;
  }
  const credential = (
    await db()
      .select({ encryptedKey: credentials.encryptedKey })
      .from(credentials)
      .where(eq(credentials.agentId, agentId))
      .limit(1)
  ).at(0);
  const { apiKey } = resolveOpenRouterApiKey(agentId, credential?.encryptedKey);
  return openRouterEmbedders(apiKey).embedMany;
}
