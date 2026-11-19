import { expect, test } from 'bun:test';

import { mergeHybridRanks } from '@/lib/knowledge/rank';

test('merges vector and text ranks with reciprocal rank fusion', () => {
  const merged = mergeHybridRanks(
    [
      { id: 'a', vectorScore: 0.91 },
      { id: 'b', vectorScore: 0.8 },
      { id: 'c', vectorScore: 0.7 },
    ],
    [
      { id: 'b', textScore: 0.6 },
      { id: 'd', textScore: 0.55 },
      { id: 'a', textScore: 0.4 },
    ],
    { limit: 3, k: 60 },
  );

  expect(merged).toHaveLength(3);
  expect(merged[0]?.id).toBe('b');
  expect(merged[0]?.reasons.some((reason) => reason.includes('vector'))).toBe(true);
  expect(merged[0]?.reasons.some((reason) => reason.includes('text'))).toBe(true);
  expect(merged.map((hit) => hit.id)).toContain('a');
  expect(merged.every((hit) => hit.rankScore > 0)).toBe(true);
});

test('keeps single-list candidates and respects limit', () => {
  const merged = mergeHybridRanks(
    [{ id: 'only-vector', vectorScore: 0.5 }],
    [{ id: 'only-text', textScore: 0.9 }],
    { limit: 1 },
  );
  expect(merged).toHaveLength(1);
  expect(['only-vector', 'only-text']).toContain(merged[0]?.id);
});
