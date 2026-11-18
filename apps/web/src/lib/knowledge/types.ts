export type KnowledgeDocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';
export type KnowledgeContentKind = 'pdf' | 'markdown' | 'plain' | 'faq';

export const KNOWLEDGE_JOB_TYPE = 'knowledge.process';
export const KNOWLEDGE_SEARCH_TOOL = 'knowledge.search';
export const DEFAULT_KNOWLEDGE_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
export const DEFAULT_KNOWLEDGE_EMBEDDING_DIMENSIONS = 1536;
export const maxKnowledgeBytes = 10 * 1024 * 1024;

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
