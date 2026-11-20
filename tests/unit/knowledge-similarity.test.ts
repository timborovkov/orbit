import { describe, expect, test } from 'bun:test';

import {
  cosineSimilarity,
  cosineSimilarityFromDistance,
} from '../../apps/web/src/lib/knowledge/similarity';

describe('cosineSimilarityFromDistance', () => {
  test('converts pgvector cosine distance to similarity', () => {
    expect(cosineSimilarityFromDistance(0)).toBe(1);
    expect(cosineSimilarityFromDistance(0.25)).toBe(0.75);
    expect(cosineSimilarityFromDistance(1)).toBe(0);
    expect(cosineSimilarityFromDistance(1.2)).toBeCloseTo(-0.2);
  });

  test('rejects non-finite distances', () => {
    expect(() => cosineSimilarityFromDistance(Number.NaN)).toThrow();
    expect(() => cosineSimilarityFromDistance(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('cosineSimilarity', () => {
  test('returns 1 for identical unit vectors', () => {
    const vector = [0.6, 0.8];
    expect(cosineSimilarity(vector, vector)).toBeCloseTo(1);
  });

  test('matches 1 - cosine distance for the same pair', () => {
    const a = [1, 0, 0];
    const b = [0.6, 0.8, 0];
    const similarity = cosineSimilarity(a, b);
    const distance = 1 - similarity;
    expect(cosineSimilarityFromDistance(distance)).toBeCloseTo(similarity);
  });
});
