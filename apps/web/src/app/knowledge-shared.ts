import { z } from 'zod';

import type { KnowledgeContentKind, KnowledgeDocumentStatus } from '@/lib/knowledge/types';

export const knowledgeSourceSchema = z.object({
  id: z.number().int().positive(),
  documentId: z.string().optional(),
  sourceFilename: z.string(),
  page: z.number().nullable(),
  section: z.string().nullable(),
  content: z.string(),
});

export function knowledgeSourceHref(agentId: string, documentId?: string) {
  if (!documentId || !z.uuid().safeParse(documentId).success) return undefined;
  return `/agents/${encodeURIComponent(agentId)}/knowledge/sources/${documentId}`;
}

export interface KnowledgeLibraryAccess {
  id: string;
  name: string;
  documentCount: number;
  readyCount: number;
  pendingCount: number;
  updatedAt: string | null;
}

export interface KnowledgeDoc {
  id: string;
  filename: string;
  title: string;
  contentKind: KnowledgeContentKind;
  mimeType: string;
  byteSize: number;
  status: KnowledgeDocumentStatus;
  error: string | null;
  chunkCount: number;
  embeddedCount: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  processedAt: Date | string | null;
}

export interface InspectionHit {
  chunkId: string;
  documentId: string;
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

export const KNOWLEDGE_ACCEPT =
  '.pdf,.md,.markdown,.txt,.faq,application/pdf,text/markdown,text/plain,text/x-faq';

export const knowledgeStatusLabels: Record<KnowledgeDocumentStatus, string> = {
  pending: 'Pending',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
};

export const knowledgeKindLabels: Record<KnowledgeContentKind, string> = {
  pdf: 'PDF',
  markdown: 'Markdown',
  plain: 'Text',
  faq: 'FAQ',
};

export function formatKnowledgeBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function asKnowledgeDate(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

export function knowledgeStatusBadgeVariant(
  status: KnowledgeDocumentStatus,
): 'outline' | 'secondary' | 'destructive' {
  if (status === 'failed') return 'destructive';
  if (status === 'ready') return 'outline';
  return 'secondary';
}

export function knowledgeChunkLabel(count: number) {
  return `${count} chunk${count === 1 ? '' : 's'}`;
}
