import { and, eq, isNull, or, sql } from 'drizzle-orm';

import { BudgetError, checkRequestBudgets } from '@/lib/budgets';
import { db, sqlClient } from '@/lib/db';
import { mergeHybridRanks } from '@/lib/knowledge/rank';
import { authorizeAction, loadPolicyContext } from '@/lib/policy/gateway';
import {
  knowledgeEmbeddingDimensions,
  knowledgeEmbeddingModelId,
  validateKnowledgeVector,
} from '@/lib/runtime/knowledge/embed';
import { resolveKnowledgeEmbedders } from '@/lib/runtime/knowledge/provider';
import { MEMORY_LIMIT, MEMORY_SEARCH, type RecalledMemory } from '@/lib/runtime/memory/types';
import { reportFailure } from '@/lib/runtime/telemetry';
import { evaluationComparisons, runs } from '@/lib/schema';

type RecallInput = {
  agentId: string;
  actor: string;
  runId: string;
  executionToken: string;
  query: string;
  replay: boolean;
  signal: AbortSignal;
};

const available = () => sqlClient()`
  (expires_on IS NULL OR expires_on > (now() AT TIME ZONE 'UTC')::date)
  AND (
    EXISTS (SELECT 1 FROM email_messages AS message
      WHERE message.id = agent_memories.email_message_id AND message.agent_id = agent_memories.agent_id
        AND message.run_id = agent_memories.run_id AND message.body IS NOT NULL)
    OR EXISTS (SELECT 1 FROM source_events AS event
      WHERE event.id = agent_memories.source_event_id AND event.agent_id = agent_memories.agent_id
        AND event.run_id = agent_memories.run_id)
  )
`;

type RecallRow = Omit<RecalledMemory, 'learnedAt'> & { learnedAt: Date | string };
type VectorRow = RecallRow & { distance: number };
type TextRow = RecallRow & { rank: number };

async function rankMemories(agentId: string, query: string, model: string, vector: string | null) {
  const store = sqlClient();
  const columns = store`id, revision, subject_kind AS "subjectKind", subject, topic, fact,
    learned_at AS "learnedAt"`;
  const scope = store`agent_id = ${agentId} AND ${available()}`;
  const candidateLimit = MEMORY_LIMIT * 3;
  const [semantic, lexical] = await Promise.all([
    vector
      ? store<VectorRow[]>`
        WITH scoped AS MATERIALIZED (
          SELECT id, revision, subject_kind, subject, topic, fact, learned_at, embedding
          FROM agent_memories WHERE ${scope} AND embedding IS NOT NULL AND embedding_model = ${model}
        )
        SELECT ${columns}, embedding <=> ${vector}::vector AS distance FROM scoped
        WHERE embedding <=> ${vector}::vector <= 0.6
        ORDER BY distance, id LIMIT ${candidateLimit}
      `
      : Promise.resolve([]),
    store<TextRow[]>`
      WITH terms AS (
        SELECT string_agg(quote_literal(term), ' | ')::tsquery AS query
        FROM unnest(tsvector_to_array(to_tsvector('english', ${query}))) AS term
      )
      SELECT ${columns}, ts_rank_cd(search_vector, terms.query) AS rank
      FROM agent_memories CROSS JOIN terms
      WHERE ${scope} AND search_vector @@ terms.query
      ORDER BY rank DESC, id LIMIT ${candidateLimit}
    `,
  ]);
  return mergeHybridRanks<RecallRow>(
    semantic.map(({ distance, ...row }) => ({ ...row, vectorScore: 1 - distance })),
    lexical.map(({ rank, ...row }) => ({ ...row, textScore: rank })),
    { limit: MEMORY_LIMIT },
  ).map(({ source: { id, revision, subjectKind, subject, topic, fact, learnedAt } }) => ({
    id,
    revision,
    subjectKind,
    subject,
    topic,
    fact,
    learnedAt: new Date(learnedAt).toISOString(),
  }));
}

async function comparisonSnapshot(input: RecallInput) {
  if (!input.replay) return;
  return (
    await db()
      .select({
        id: evaluationComparisons.id,
        snapshot: evaluationComparisons.memorySnapshot,
        leftRunId: evaluationComparisons.leftRunId,
      })
      .from(evaluationComparisons)
      .where(
        and(
          eq(evaluationComparisons.agentId, input.agentId),
          eq(evaluationComparisons.status, 'running'),
          or(
            eq(evaluationComparisons.leftRunId, input.runId),
            eq(evaluationComparisons.rightRunId, input.runId),
          ),
        ),
      )
  ).at(0);
}

export async function recallRunMemories(input: RecallInput): Promise<RecalledMemory[]> {
  const comparison = await comparisonSnapshot(input);
  const query = input.query.trim().slice(0, 2000);
  const model = knowledgeEmbeddingModelId();
  const candidates =
    query && !comparison?.snapshot
      ? (
          await sqlClient()`
        SELECT count(*)::int AS count, COALESCE(bool_or(
          embedding IS NOT NULL AND embedding_model = ${model}
        ), false) AS semantic
        FROM agent_memories WHERE agent_id = ${input.agentId} AND ${available()}
      `
        ).at(0)
      : null;

  let snapshot: RecalledMemory[] = [];
  if (comparison?.snapshot?.length || (candidates?.count ?? 0) > 0) {
    const ctx = await loadPolicyContext(input.agentId, input.actor, input.runId);
    if (!ctx) return [];
    const policy = await authorizeAction(ctx, {
      type: MEMORY_SEARCH,
      idempotencyKey: `${MEMORY_SEARCH}:${input.runId}`,
      readOnly: true,
      executionToken: input.executionToken,
    });
    if (policy.decision !== 'allow') return [];
    if (comparison?.snapshot) return comparison.snapshot;

    // Keep headroom for the evaluator and main generation before embedding a query.
    const budget = {
      budgets: ctx.budgets,
      day: ctx.usage,
      month: ctx.usage.month,
      activeRuns: 0,
    };
    let vector: string | null = null;
    if (candidates?.semantic && !checkRequestBudgets(budget, BigInt(0), 3)) {
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(5000)]);
      try {
        const provider = await resolveKnowledgeEmbedders(input.agentId, {
          runId: input.runId,
          token: input.executionToken,
          signal,
        });
        vector = JSON.stringify(
          validateKnowledgeVector(
            await provider.embedOne(query, signal),
            knowledgeEmbeddingDimensions(),
          ),
        );
      } catch (error) {
        if (input.signal.aborted) throw new BudgetError('cancelled');
        reportFailure('worker.runtime', { agentId: input.agentId, runId: input.runId }, error);
      }
    }
    snapshot = await rankMemories(input.agentId, query, model, vector);
  }

  if (!comparison || comparison.snapshot) return snapshot;

  // A comparison first snapshots on its left side. A legacy comparison that
  // already finished that side without a snapshot keeps an empty context.
  const shared = comparison.leftRunId === input.runId ? snapshot : [];
  return db().transaction(async (tx) => {
    const [comparisonRow] = await tx
      .select({ snapshot: evaluationComparisons.memorySnapshot })
      .from(evaluationComparisons)
      .where(
        and(
          eq(evaluationComparisons.id, comparison.id),
          eq(evaluationComparisons.agentId, input.agentId),
          eq(evaluationComparisons.status, 'running'),
        ),
      )
      .for('update');
    if (!comparisonRow) return [];
    if (comparisonRow.snapshot) return comparisonRow.snapshot;
    const [run] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.id, input.runId),
          eq(runs.agentId, input.agentId),
          eq(runs.origin, 'replay'),
          eq(runs.executionToken, input.executionToken),
          eq(runs.status, 'running'),
          sql`${runs.expiresAt} > now()`,
        ),
      )
      .for('update');
    if (!run) return [];
    await tx
      .update(evaluationComparisons)
      .set({ memorySnapshot: shared })
      .where(
        and(
          eq(evaluationComparisons.id, comparison.id),
          isNull(evaluationComparisons.memorySnapshot),
        ),
      );
    return shared;
  });
}
