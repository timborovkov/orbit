export type KnowledgeDocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';
export type KnowledgeContentKind = 'pdf' | 'markdown' | 'plain' | 'faq';

export const KNOWLEDGE_JOB_TYPE = 'knowledge.process';
export const KNOWLEDGE_SEARCH_TOOL = 'knowledge.search';
export const DEFAULT_KNOWLEDGE_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
export const DEFAULT_KNOWLEDGE_EMBEDDING_DIMENSIONS = 1536;
/** Advertised and validated upload ceiling. Server Actions allow a little more for multipart overhead. */
export const maxKnowledgeBytes = 10 * 1024 * 1024;
export const maxKnowledgeUploadLabel = '10 MB';
/** Bound chunk inserts so a large FAQ stays under Postgres' 65,535 bind parameter limit. */
export const KNOWLEDGE_CHUNK_INSERT_BATCH = 200;

export interface KnowledgeChunkDraft {
  filename: string;
  title: string;
  page?: number | null;
  section?: string | null;
  startOffset: number;
  endOffset: number;
  index: number;
  content: string;
  contentHash: string;
}

export interface RankedKnowledgeHit {
  chunkId: string;
  documentId: string;
  agentId: string;
  content: string;
  sourceFilename: string;
  sourceTitle: string;
  page: number | null;
  section: string | null;
  startOffset: number;
  endOffset: number;
  vectorScore: number | null;
  textScore: number | null;
  rankScore: number;
  reasons: string[];
}

export interface KnowledgeSearchResult {
  query: string;
  hits: RankedKnowledgeHit[];
}
