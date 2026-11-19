import { z } from 'zod';

import { isBudgetError } from '@/lib/budgets';
import { KNOWLEDGE_SEARCH_TOOL } from '@/lib/knowledge/types';
import {
  authorizeAction,
  loadPolicyContext,
  recordBlockedDispatch,
  type PolicyResult,
} from '@/lib/policy/gateway';
import { resolveKnowledgeEmbedders } from '@/lib/runtime/knowledge/provider';
import { searchKnowledge } from '@/lib/runtime/knowledge/search';

interface KnowledgeSearchToolInput {
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
  };
}

const searchInput = z.object({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(20).default(8),
});

export async function executeKnowledgeSearchTool(input: KnowledgeSearchToolInput): Promise<{
  policy: PolicyResult;
  result?: Awaited<ReturnType<typeof searchKnowledge>>;
}> {
  const { query, limit } = searchInput.parse(input);
  const ctx = await loadPolicyContext(input.agentId, input.actor, input.runId);
  if (!ctx) throw new Error('Agent not found');
  const policy = await authorizeAction(ctx, {
    type: KNOWLEDGE_SEARCH_TOOL,
    idempotencyKey: input.idempotencyKey,
    readOnly: true,
    executionToken: input.execution?.token,
    payload: { query, limit },
  });
  if (policy.decision !== 'allow') return { policy };

  const signal = input.signal ?? input.execution?.signal;
  try {
    const result = await searchKnowledge({
      agentId: input.agentId,
      query,
      limit,
      signal,
      embedQuery: async (value) => {
        const provider = await resolveKnowledgeEmbedders(
          input.agentId,
          input.execution && { ...input.execution, requiredTool: KNOWLEDGE_SEARCH_TOOL },
        );
        return provider.embedOne(value, signal);
      },
    });
    return { policy, result };
  } catch (error) {
    if (!isBudgetError(error)) throw error;
    return {
      policy: await recordBlockedDispatch(ctx, KNOWLEDGE_SEARCH_TOOL, policy.intentId, error),
    };
  }
}
