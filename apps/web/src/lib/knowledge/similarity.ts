/**
 * Convert pgvector cosine distance (`<=>`) to cosine similarity.
 * Cosine distance is defined as `1 - cosine_similarity`, so similarity is
 * `1 - distance`. Values can be negative when vectors point apart.
 */
export function cosineSimilarityFromDistance(distance: number): number {
  if (!Number.isFinite(distance)) {
    throw new Error('Cosine distance must be a finite number');
  }
  return 1 - distance;
}

/** Cosine similarity for two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    throw new Error('Vectors must be non-empty and the same length');
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
