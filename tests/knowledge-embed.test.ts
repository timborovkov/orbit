import { expect, test } from 'bun:test';

import { KNOWLEDGE_CHUNK_INSERT_BATCH } from '@/lib/knowledge/types';
import { knowledgeEmbeddingReuseKey } from '@/lib/runtime/knowledge/embed';

test('embedding reuse keys include model and dimensions', () => {
  const sameContent = knowledgeEmbeddingReuseKey(0, 'abc', 'openai/text-embedding-3-small', 1536);
  const otherModel = knowledgeEmbeddingReuseKey(0, 'abc', 'openai/text-embedding-3-large', 1536);
  const otherDims = knowledgeEmbeddingReuseKey(0, 'abc', 'openai/text-embedding-3-small', 3072);
  expect(sameContent).not.toBe(otherModel);
  expect(sameContent).not.toBe(otherDims);
  expect(sameContent).toContain('openai/text-embedding-3-small');
  expect(sameContent).toContain('1536');
});

test('chunk insert batch stays under Postgres bind-parameter pressure', () => {
  // Each chunk row binds ~12 columns; 200 * 12 = 2400 << 65535.
  expect(KNOWLEDGE_CHUNK_INSERT_BATCH).toBeGreaterThan(0);
  expect(KNOWLEDGE_CHUNK_INSERT_BATCH * 12).toBeLessThan(65_535);
});
