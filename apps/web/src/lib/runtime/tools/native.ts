import { KNOWLEDGE_SEARCH_TOOL } from '@/lib/knowledge/types';
import { executeKnowledgeSearchTool } from '@/lib/runtime/tools/knowledge-search';

export const nativeTools = {
  [KNOWLEDGE_SEARCH_TOOL]: executeKnowledgeSearchTool,
} as const;
