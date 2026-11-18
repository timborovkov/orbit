import { eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { openRouterEmbedders } from '@/lib/knowledge/embed';
import { searchKnowledge } from '@/lib/knowledge/search';
import { KNOWLEDGE_SEARCH_TOOL } from '@/lib/knowledge/types';
import { authorizeAction, loadPolicyContext, type PolicyResult } from '@/lib/policy/gateway';
import { resolveOpenRouterApiKey } from '@/lib/runtime/openrouter-key';
import { credentials } from '@/lib/schema';

export interface KnowledgeSearchToolInput {
  actor: string;
  agentId: string;
  query: string;
  limit?: number;
  runId?: string | null;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export async function executeKnowledgeSearchTool(input: KnowledgeSearchToolInput): Promise<{
  policy: PolicyResult;
  result?: Awaited<ReturnType<typeof searchKnowledge>>;
}> {
  const ctx = await loadPolicyContext(input.agentId, input.actor, input.runId);
  if (!ctx) throw new Error('Agent not found');

  const policy = await authorizeAction(ctx, {
    type: KNOWLEDGE_SEARCH_TOOL,
    idempotencyKey: input.idempotencyKey,
    readOnly: true,
    payload: { query: input.query, limit: input.limit ?? 8 },
  });

  if (policy.decision !== 'allow') {
    return { policy };
  }

  const credential = (
    await db()
      .select({ encryptedKey: credentials.encryptedKey })
      .from(credentials)
      .where(eq(credentials.agentId, input.agentId))
      .limit(1)
  ).at(0);
  const { apiKey } = resolveOpenRouterApiKey(input.agentId, credential?.encryptedKey);
  const { embedOne } = openRouterEmbedders(apiKey);
  const result = await searchKnowledge({
    agentId: input.agentId,
    query: input.query,
    limit: input.limit,
    embedQuery: embedOne,
    signal: input.signal,
  });
  return { policy, result };
}
