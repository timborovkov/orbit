import { sqlClient } from '@/lib/db';
import type { EmbedOneFn } from '@/lib/knowledge/embed';
import { mergeHybridRanks } from '@/lib/knowledge/rank';
import { cosineSimilarityFromDistance } from '@/lib/knowledge/similarity';
import type { KnowledgeSearchResult, RankedKnowledgeHit } from '@/lib/knowledge/types';

function vectorLiteral(values: number[]) {
  return `[${values.join(',')}]`;
}

interface SearchRow {
  id: unknown;
  document_id: unknown;
  agent_id: unknown;
  content: unknown;
  source_filename: unknown;
  source_title: unknown;
  page: unknown;
  section: unknown;
  start_offset: unknown;
  end_offset: unknown;
  vector_distance?: unknown;
  vector_score?: unknown;
  text_score?: unknown;
}

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown) {
  return typeof value === 'number' ? value : Number(value);
}

function asNullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = asNumber(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asNullableString(value: unknown) {
  return typeof value === 'string' ? value : null;
}

export async function searchKnowledge(input: {
  agentId: string;
  query: string;
  limit?: number;
  embedQuery: EmbedOneFn;
  signal?: AbortSignal;
}): Promise<KnowledgeSearchResult> {
  const query = input.query.trim();
  if (!query) return { query, hits: [] };
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 20);
  const candidateLimit = Math.max(limit * 3, 12);
  const embedding = await input.embedQuery(query, input.signal);
  const client = sqlClient();
  const vectorLiteralValue = vectorLiteral(embedding);

  const [vectorRows, textRows] = await Promise.all([
    client`
      SELECT
        id,
        document_id,
        agent_id,
        content,
        source_filename,
        source_title,
        page,
        section,
        start_offset,
        end_offset,
        embedding <=> ${vectorLiteralValue}::vector AS vector_distance
      FROM knowledge_chunks
      WHERE agent_id = ${input.agentId}
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vectorLiteralValue}::vector
      LIMIT ${candidateLimit}
    `,
    client`
      SELECT
        id,
        document_id,
        agent_id,
        content,
        source_filename,
        source_title,
        page,
        section,
        start_offset,
        end_offset,
        ts_rank_cd(search_vector, plainto_tsquery('english', ${query})) AS text_score
      FROM knowledge_chunks
      WHERE agent_id = ${input.agentId}
        AND search_vector @@ plainto_tsquery('english', ${query})
      ORDER BY text_score DESC
      LIMIT ${candidateLimit}
    `,
  ]);

  const toCandidate = (row: SearchRow, kind: 'vector' | 'text', index: number) => ({
    id: asString(row.id),
    documentId: asString(row.document_id),
    agentId: asString(row.agent_id),
    content: asString(row.content),
    sourceFilename: asString(row.source_filename),
    sourceTitle: asString(row.source_title),
    page: asNullableNumber(row.page),
    section: asNullableString(row.section),
    startOffset: asNumber(row.start_offset),
    endOffset: asNumber(row.end_offset),
    vectorRank: kind === 'vector' ? index + 1 : null,
    textRank: kind === 'text' ? index + 1 : null,
    vectorScore:
      kind === 'vector'
        ? (() => {
            const distance = asNullableNumber(row.vector_distance);
            return distance === null ? null : cosineSimilarityFromDistance(distance);
          })()
        : null,
    textScore: kind === 'text' ? asNullableNumber(row.text_score) : null,
  });

  const merged = mergeHybridRanks(
    [...vectorRows].map((row, index) => toCandidate(row as SearchRow, 'vector', index)),
    [...textRows].map((row, index) => toCandidate(row as SearchRow, 'text', index)),
    { limit },
  );

  const hits: RankedKnowledgeHit[] = merged.map((entry) => ({
    chunkId: entry.id,
    documentId: entry.source.documentId,
    agentId: entry.source.agentId,
    content: entry.source.content,
    sourceFilename: entry.source.sourceFilename,
    sourceTitle: entry.source.sourceTitle,
    page: entry.source.page,
    section: entry.source.section,
    startOffset: entry.source.startOffset,
    endOffset: entry.source.endOffset,
    vectorScore: entry.vectorScore ?? null,
    textScore: entry.textScore ?? null,
    rankScore: entry.rankScore,
    reasons: entry.reasons,
  }));

  return { query, hits };
}
