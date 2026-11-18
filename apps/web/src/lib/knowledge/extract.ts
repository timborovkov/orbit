import { createHash } from 'node:crypto';

import type { ExtractedSection } from '@/lib/knowledge/chunk';
import {
  maxKnowledgeBytes,
  maxKnowledgeUploadLabel,
  type KnowledgeContentKind,
} from '@/lib/knowledge/types';

export interface ExtractedDocument {
  text: string;
  contentHash: string;
  sections: ExtractedSection[];
}

const mimeToKind: Record<string, KnowledgeContentKind> = {
  'application/pdf': 'pdf',
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
  'text/plain': 'plain',
  'text/x-faq': 'faq',
};

function detectKnowledgeKind(filename: string, mimeType: string): KnowledgeContentKind | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.faq') || mimeType === 'text/x-faq') return 'faq';
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || mimeType.includes('markdown'))
    return 'markdown';
  if (lower.endsWith('.pdf') || mimeType === 'application/pdf') return 'pdf';
  if (lower.endsWith('.txt') || mimeType === 'text/plain' || mimeType.startsWith('text/'))
    return 'plain';
  return mimeToKind[mimeType] ?? null;
}

export function validateKnowledgeUpload(file: {
  name: string;
  type: string;
  size: number;
}): { kind: KnowledgeContentKind; mimeType: string } | { error: string } {
  if (!file.size) return { error: 'Choose a non-empty file.' };
  if (file.size > maxKnowledgeBytes)
    return { error: `Choose a file smaller than ${maxKnowledgeUploadLabel}.` };
  const kind = detectKnowledgeKind(file.name, file.type || 'application/octet-stream');
  if (!kind) return { error: 'Upload a PDF, Markdown, plain text or FAQ file.' };
  const mimeType =
    kind === 'pdf'
      ? 'application/pdf'
      : kind === 'markdown'
        ? 'text/markdown'
        : kind === 'faq'
          ? 'text/x-faq'
          : 'text/plain';
  return { kind, mimeType };
}

function hashBytes(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeText(bytes: Uint8Array) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '');
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractedDocument> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes);
  const extracted = await extractText(pdf, { mergePages: false });
  const rawPages: string[] = Array.isArray(extracted.text) ? extracted.text : [extracted.text];
  const pages = rawPages.map((page) => page.replace(/\r\n/g, '\n').trim());
  const sections: ExtractedSection[] = [];
  const parts: string[] = [];
  let offset = 0;
  for (let i = 0; i < pages.length; i += 1) {
    const pageText = pages[i] ?? '';
    if (!pageText) continue;
    if (parts.length) {
      parts.push('\n\n');
      offset += 2;
    }
    sections.push({
      content: pageText,
      page: i + 1,
      section: `Page ${i + 1}`,
      startOffset: offset,
    });
    parts.push(pageText);
    offset += pageText.length;
  }
  const full = parts.join('');
  if (!full.trim()) {
    throw new Error(
      extracted.totalPages
        ? 'No extractable text was found in this PDF.'
        : 'This PDF could not be read.',
    );
  }
  return { text: full, contentHash: hashBytes(bytes), sections };
}

export async function extractKnowledgeDocument(
  bytes: Uint8Array,
  kind: KnowledgeContentKind,
): Promise<ExtractedDocument> {
  if (kind === 'pdf') return extractPdf(bytes);
  const text = decodeText(bytes).replace(/\r\n/g, '\n').trim();
  if (!text) throw new Error('The file did not contain readable text.');
  // Leave sections empty for markdown/plain/faq so the chunker can apply kind-aware
  // splits (Markdown headings, FAQ pairs). A synthetic whole-document section would
  // short-circuit heading detection.
  return {
    text,
    contentHash: hashBytes(bytes),
    sections: [],
  };
}
