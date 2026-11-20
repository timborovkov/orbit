import { expect, test } from 'bun:test';

import { chunkExtractedText } from '@/lib/knowledge/chunk';

test('chunks plain text with source offsets', () => {
  const text = `${'Alpha sentence. '.repeat(40)}\n\n${'Beta sentence. '.repeat(40)}`;
  const chunks = chunkExtractedText({
    text,
    kind: 'plain',
    filename: 'guide.txt',
    title: 'Guide',
  });
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[0]?.filename).toBe('guide.txt');
  expect(chunks[0]?.startOffset).toBe(0);
  expect(chunks[0]?.endOffset).toBeGreaterThan(chunks[0]!.startOffset);
  expect(chunks.every((chunk) => chunk.contentHash.length === 64)).toBe(true);
});

test('chunks markdown by headings when present', () => {
  const text = `# Pricing\n\nOrbit is free for local use.\n\n## Limits\n\nDaily spend caps apply.`;
  const chunks = chunkExtractedText({
    text,
    kind: 'markdown',
    filename: 'pricing.md',
    title: 'Pricing',
  });
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  expect(chunks.some((chunk) => chunk.section === 'Pricing')).toBe(true);
  expect(chunks.some((chunk) => chunk.section === 'Limits')).toBe(true);
});

test('markdown heading splits win over a synthetic whole-document section', () => {
  const text = `# Pricing\n\nOrbit is free for local use.\n\n## Limits\n\nDaily spend caps apply.`;
  const chunks = chunkExtractedText({
    text,
    kind: 'markdown',
    filename: 'pricing.md',
    title: 'Pricing',
    sections: [{ content: text, startOffset: 0 }],
  });
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  expect(chunks.some((chunk) => chunk.section === 'Pricing')).toBe(true);
  expect(chunks.some((chunk) => chunk.section === 'Limits')).toBe(true);
});

test('chunks FAQ into question/answer pairs', () => {
  const text = `Q: How do I reset my password?\nA: Use the account settings page.\n\nQ: Where are invoices?\nA: Open Billing → Invoices.`;
  const chunks = chunkExtractedText({
    text,
    kind: 'faq',
    filename: 'support.faq',
    title: 'Support FAQ',
  });
  expect(chunks).toHaveLength(2);
  expect(chunks[0]?.section).toContain('reset my password');
  expect(chunks[1]?.content).toContain('Billing');
});

test('preserves PDF page sections', () => {
  const chunks = chunkExtractedText({
    text: 'Page one body\n\nPage two body',
    kind: 'pdf',
    filename: 'manual.pdf',
    title: 'Manual',
    sections: [
      { content: 'Page one body', page: 1, section: 'Page 1', startOffset: 0 },
      { content: 'Page two body', page: 2, section: 'Page 2', startOffset: 15 },
    ],
  });
  expect(chunks).toHaveLength(2);
  expect(chunks[0]?.page).toBe(1);
  expect(chunks[1]?.page).toBe(2);
});
