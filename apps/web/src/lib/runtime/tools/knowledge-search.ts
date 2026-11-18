import { eq } from 'drizzle-orm';

import { isBudgetError } from '@/lib/budgets';
import { db } from '@/lib/db';
import { openRouterEmbedders, stubEmbedders } from '@/lib/knowledge/embed';
import { searchKnowledge } from '@/lib/knowledge/search';
import { KNOWLEDGE_EMBEDDING_RESERVE_MICROS, KNOWLEDGE_SEARCH_TOOL } from '@/lib/knowledge/types';
import {
  authorizeAction,
  loadPolicyContext,
  reserveRequestQuota,
  type PolicyResult,
} from '@/lib/policy/gateway';
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
  execution?: {
    runId: string;
    token: string;
    signal: AbortSignal;
    stage?: 'evaluator' | 'main';
  };
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

  let settle: ((billedMicros: number) => Promise<void>) | null = null;
  try {
    settle = await reserveRequestQuota(
      input.agentId,
      KNOWLEDGE_EMBEDDING_RESERVE_MICROS,
      input.execution,
    );
  } catch (error) {
    if (isBudgetError(error)) {
      return {
        policy: {
          ...policy,
          decision: 'deny',
          reasons: [error.message],
          violation: error.kind === 'cancelled' ? undefined : error.kind,
        },
      };
    }
    throw error;
  }

  try {
    let embedOne: (value: string, signal?: AbortSignal) => Promise<number[]>;
    if (process.env.KNOWLEDGE_EMBEDDING_STUB === 'true') {
      embedOne = stubEmbedders().embedOne;
    } else {
      const credential = (
        await db()
          .select({ encryptedKey: credentials.encryptedKey })
          .from(credentials)
          .where(eq(credentials.agentId, input.agentId))
          .limit(1)
      ).at(0);
      const { apiKey } = resolveOpenRouterApiKey(input.agentId, credential?.encryptedKey);
      embedOne = openRouterEmbedders(apiKey).embedOne;
    }

    const result = await searchKnowledge({
      agentId: input.agentId,
      query: input.query,
      limit: input.limit,
      embedQuery: embedOne,
      signal: input.signal ?? input.execution?.signal,
    });
    // Embedding providers do not yet report a settled USD cost here; release the spend
    // reservation while keeping the request counter increment from reserveRequestQuota.
    await settle(0);
    return { policy, result };
  } catch (error) {
    await settle(0);
    throw error;
  }
}
