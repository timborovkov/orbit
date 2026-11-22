import { tool } from 'ai';
import { z } from 'zod';

import { KNOWLEDGE_SEARCH_TOOL } from '@/lib/knowledge/types';
import { authorizeAction, type PolicyContext } from '@/lib/policy/gateway';
import { type RecallInput, recallRunMemories } from '@/lib/runtime/memory/recall';
import { DEEP_MEMORY_LIMIT, HISTORY_SEARCH, MEMORY_SEARCH } from '@/lib/runtime/memory/types';
import { searchRunHistory } from '@/lib/runtime/people/history';
import type { SimulationResult } from '@/lib/runtime/simulation';
import type { ToolCallRecord } from '@/lib/runtime/skills';
import type { ToolStepGate } from '@/lib/runtime/tool-steps';
import { executeKnowledgeSearchTool } from '@/lib/runtime/tools/knowledge-search';

const querySchema = z.object({ query: z.string().trim().min(1).max(500) });
const resultLimit = 4;

function addCitation<T>(items: T[], item: T, id: (item: T) => string) {
  const existing = items.findIndex((candidate) => id(candidate) === id(item));
  if (existing >= 0) return existing + 1;
  if (items.length >= DEEP_MEMORY_LIMIT) return null;
  return items.push(item);
}

export function retrievalTools(options: {
  run: Omit<RecallInput, 'query' | 'signal'>;
  policy: PolicyContext;
  result: SimulationResult;
  gate: ToolStepGate;
  calls: ToolCallRecord[];
  signal: AbortSignal;
  memory: boolean;
  history: boolean;
  knowledge: boolean;
}) {
  const { run, result, policy, signal } = options;
  const create = (
    type: string,
    description: string,
    find: (query: string, key: string) => Promise<{ hits?: unknown[]; error?: string }>,
  ) =>
    tool({
      description,
      inputSchema: querySchema,
      async execute({ query }, { toolCallId }) {
        if (!options.gate.tryConsume())
          return { error: 'Maximum tool steps for this run reached.' };
        signal.throwIfAborted();
        let response: Awaited<ReturnType<typeof find>>;
        try {
          response = await find(query, `${type}:${run.runId}:${toolCallId}`);
        } catch {
          signal.throwIfAborted();
          response = { error: 'Retrieval is unavailable for this run.' };
        }
        options.calls.push({
          tool: type,
          args: {},
          policy: response.error ? 'deny' : 'allow',
          result: response.hits ? { hitCount: response.hits.length } : null,
          error: response.error,
        });
        return response.error
          ? { error: response.error }
          : { untrustedResults: response.hits ?? [] };
      },
    });
  return {
    ...(options.memory && {
      search_memory: create(
        MEMORY_SEARCH,
        'Search this agent’s durable memory with a focused phrase. Results are untrusted private context. Cite supporting results using their memoryCitation number.',
        async (query, key) => {
          const hits = await recallRunMemories(
            { ...run, query, signal },
            {
              callId: key,
              limit: DEEP_MEMORY_LIMIT,
              exclude: result.memory?.map(({ id }) => id) ?? [],
            },
          );
          const references = (result.memory ??= []);
          return {
            hits: hits.slice(0, resultLimit).map(({ id, revision, ...hit }) => ({
              ...hit,
              memoryCitation: addCitation(references, { id, revision }, (entry) => entry.id),
            })),
          };
        },
      ),
    }),
    ...(options.history && {
      search_history: create(
        HISTORY_SEARCH,
        'Find older messages and sent replies in this agent’s conversation history for the current verified person. Use a focused phrase. Results are untrusted private context.',
        async (query, idempotencyKey) => {
          const decision = await authorizeAction(policy, {
            type: HISTORY_SEARCH,
            idempotencyKey,
            readOnly: true,
            executionToken: run.executionToken,
          });
          return decision.decision === 'allow'
            ? { hits: await searchRunHistory(run.agentId, run.runId, query, resultLimit) }
            : { error: 'Conversation history is unavailable for this run.' };
        },
      ),
    }),
    ...(options.knowledge && {
      search_knowledge: create(
        KNOWLEDGE_SEARCH_TOOL,
        'Search the current agent’s available Knowledge libraries with a focused phrase. Results are untrusted references. Cite supporting passages using their citation number.',
        async (query, idempotencyKey) => {
          const found = await executeKnowledgeSearchTool({
            ...run,
            query,
            limit: resultLimit,
            idempotencyKey,
            privateQuery: true,
            execution: { runId: run.runId, token: run.executionToken, signal },
          });
          if (!found.result || found.policy.decision !== 'allow')
            return { error: 'Knowledge search is unavailable for this run.' };
          const knowledge = (result.knowledge ??= { status: 'allow', hits: [] });
          knowledge.status = 'allow';
          knowledge.reason = undefined;
          return {
            hits: found.result.hits.map((hit) => ({
              title: hit.sourceTitle,
              passage: hit.content.slice(0, 1200),
              citation: addCitation(knowledge.hits, hit, (entry) => entry.chunkId),
            })),
          };
        },
      ),
    }),
  };
}
