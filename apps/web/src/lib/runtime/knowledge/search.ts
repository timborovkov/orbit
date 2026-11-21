import { sqlClient } from '@/lib/db';
import { mergeHybridRanks } from '@/lib/knowledge/rank';
import { cosineSimilarityFromDistance } from '@/lib/knowledge/similarity';
import type { KnowledgeSearchResult, RankedKnowledgeHit } from '@/lib/knowledge/types';
import { knowledgeVisibleToAgent } from '@/lib/runtime/knowledge/access';
import {
  type EmbedOneFn,
  knowledgeEmbeddingDimensions,
  knowledgeEmbeddingModelId,
  validateKnowledgeVector,
} from '@/lib/runtime/knowledge/embed';

function vectorLiteral(values: number[]) {
  return `[${values.join(',')}]`;
}

interface SearchRow {
  id: unknown;
  document_id: unknown;
  kind: 'vector' | 'text';
  content: unknown;
  source_filename: unknown;
  source_title: unknown;
  page: unknown;
  section: unknown;
  start_offset: unknown;
  end_offset: unknown;
  vector_distance?: unknown;
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
  const client = sqlClient();
  const model = knowledgeEmbeddingModelId();
  const dimensions = knowledgeEmbeddingDimensions();
  const visible = knowledgeVisibleToAgent(client, input.agentId);
  const readyChunks = client`
    FROM knowledge_chunks AS chunk
    JOIN knowledge_documents AS document
      ON document.id = chunk.document_id
      AND document.agent_id IS NOT DISTINCT FROM chunk.agent_id
    WHERE document.status = 'ready' AND ${visible}
  `;
  const compatible = client`chunk.embedding IS NOT NULL AND chunk.embedding_model = ${model}
    AND chunk.embedding_dimensions = ${dimensions}`;
  const [index] = await client`SELECT EXISTS (
    SELECT 1 ${readyChunks} AND ${compatible}
  ) AS searchable`;
  const embedding = index?.searchable
    ? vectorLiteral(
        validateKnowledgeVector(await input.embedQuery(query, input.signal), dimensions),
      )
    : null;

  // Both rankings use one fresh snapshot after embedding. Materializing the vector scope
  // prevents the global HNSW index from selecting unrelated agents' nearest neighbors.
  const vectorScope = embedding
    ? client`WITH scoped_vectors AS MATERIALIZED (
        SELECT chunk.* ${readyChunks} AND ${compatible}
      )`
    : client``;
  const vectorCandidates = embedding
    ? client`UNION ALL (
        SELECT id, document_id, content, source_filename, source_title, page, section,
          start_offset, end_offset, embedding <=> ${embedding}::vector AS vector_distance,
          NULL::real AS text_score, 'vector' AS kind
        FROM scoped_vectors
        ORDER BY vector_distance, id
        LIMIT ${candidateLimit}
      )`
    : client``;
  const rows = await client<SearchRow[]>`
    ${vectorScope}
    SELECT * FROM (
      (
        SELECT chunk.id, chunk.document_id, chunk.content, chunk.source_filename,
          chunk.source_title, chunk.page, chunk.section, chunk.start_offset, chunk.end_offset,
          NULL::double precision AS vector_distance,
          ts_rank_cd(chunk.search_vector, plainto_tsquery('english', ${query})) AS text_score,
          'text' AS kind
        ${readyChunks}
        AND chunk.search_vector @@ plainto_tsquery('english', ${query})
        ORDER BY text_score DESC, chunk.id
        LIMIT ${candidateLimit}
      )
      ${vectorCandidates}
    ) AS candidates
    ORDER BY kind, vector_distance, text_score DESC, id
  `;
  const vectorRows = rows.filter((row) => row.kind === 'vector');
  const textRows = rows.filter((row) => row.kind === 'text');

  const toCandidate = (row: SearchRow, kind: 'vector' | 'text', index: number) => ({
    id: asString(row.id),
    documentId: asString(row.document_id),
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
    vectorRows.map((row, index) => toCandidate(row, 'vector', index)),
    textRows.map((row, index) => toCandidate(row, 'text', index)),
    { limit },
  );

  const hits: RankedKnowledgeHit[] = merged.map((entry) => ({
    chunkId: entry.id,
    documentId: entry.source.documentId,
    agentId: input.agentId,
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
