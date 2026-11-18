import { createHash } from 'node:crypto';

import type { KnowledgeChunkDraft, KnowledgeContentKind } from '@/lib/knowledge/types';

const DEFAULT_CHUNK_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 150;

export interface ExtractedSection {
  content: string;
  page?: number | null;
  section?: string | null;
  /** Offset into the full extracted document text. */
  startOffset: number;
}

function hashContent(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

function splitByLength(
  text: string,
  absoluteStart: number,
  page: number | null | undefined,
  section: string | null | undefined,
  filename: string,
  title: string,
  size = DEFAULT_CHUNK_CHARS,
  overlap = DEFAULT_OVERLAP_CHARS,
): KnowledgeChunkDraft[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const chunks: KnowledgeChunkDraft[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    let end = Math.min(cursor + size, normalized.length);
    if (end < normalized.length) {
      const breakAt = normalized.lastIndexOf('\n\n', end);
      if (breakAt > cursor + Math.floor(size * 0.4)) end = breakAt;
      else {
        const space = normalized.lastIndexOf(' ', end);
        if (space > cursor + Math.floor(size * 0.4)) end = space;
      }
    }
    const content = normalized.slice(cursor, end).trim();
    if (content) {
      const startOffset = absoluteStart + cursor;
      chunks.push({
        index: chunks.length,
        content,
        contentHash: hashContent(content),
        filename,
        title,
        page: page ?? null,
        section: section ?? null,
        startOffset,
        endOffset: startOffset + content.length,
      });
    }
    if (end >= normalized.length) break;
    cursor = Math.max(0, end - overlap);
  }
  return chunks;
}

/** Split FAQ Q/A pairs into one chunk per answer, falling back to length splits. */
function chunkFaq(text: string, filename: string, title: string): KnowledgeChunkDraft[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const pairs = [
    ...normalized.matchAll(
      /(?:^|\n)(?:Q(?:uestion)?|FAQ)\s*[:.-]\s*(.+?)\n(?:A(?:nswer)?)\s*[:.-]\s*([\s\S]*?)(?=(?:\n(?:Q(?:uestion)?|FAQ)\s*[:.-])|$)/gi,
    ),
  ];
  if (!pairs.length) return splitByLength(normalized, 0, null, null, filename, title);

  const drafts: KnowledgeChunkDraft[] = [];
  for (const match of pairs) {
    const question = typeof match[1] === 'string' ? match[1].trim() : '';
    const answer = typeof match[2] === 'string' ? match[2].trim() : '';
    if (!question || !answer) continue;
    const content = `Q: ${question}\nA: ${answer}`;
    const startOffset = typeof match.index === 'number' ? match.index : 0;
    drafts.push({
      index: drafts.length,
      content,
      contentHash: hashContent(content),
      filename,
      title,
      page: null,
      section: question.slice(0, 160),
      startOffset,
      endOffset: startOffset + content.length,
    });
  }
  return drafts.length ? drafts : splitByLength(normalized, 0, null, null, filename, title);
}

export function chunkExtractedText(input: {
  text: string;
  kind: KnowledgeContentKind;
  filename: string;
  title: string;
  sections?: ExtractedSection[];
}): KnowledgeChunkDraft[] {
  const { text, kind, filename, title, sections } = input;
  if (kind === 'faq') return chunkFaq(text, filename, title);

  if (sections?.length) {
    const drafts: KnowledgeChunkDraft[] = [];
    for (const section of sections) {
      const part = splitByLength(
        section.content,
        section.startOffset,
        section.page,
        section.section,
        filename,
        title,
      );
      for (const draft of part) {
        drafts.push({ ...draft, index: drafts.length });
      }
    }
    if (drafts.length) return drafts;
  }

  if (kind === 'markdown') {
    const headingSplits = [...text.matchAll(/^#{1,3}\s+.+$/gm)];
    if (headingSplits.length) {
      const sectionsFromHeadings: ExtractedSection[] = [];
      headingSplits.forEach((match, i) => {
        const start = typeof match.index === 'number' ? match.index : 0;
        const next = headingSplits.at(i + 1);
        const end = next && typeof next.index === 'number' ? next.index : text.length;
        const heading = match[0].replace(/^#+\s*/, '').trim();
        const content = text.slice(start, end).trim();
        if (!content) return;
        sectionsFromHeadings.push({
          content,
          section: heading.slice(0, 160),
          startOffset: start,
        });
      });
      if (sectionsFromHeadings.length) {
        return chunkExtractedText({
          text,
          kind: 'plain',
          filename,
          title,
          sections: sectionsFromHeadings,
        });
      }
    }
  }

  return splitByLength(text, 0, null, null, filename, title).map((draft, index) => ({
    ...draft,
    index,
  }));
}
