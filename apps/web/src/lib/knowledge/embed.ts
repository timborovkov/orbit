import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { embed, embedMany } from 'ai';

import {
  DEFAULT_KNOWLEDGE_EMBEDDING_DIMENSIONS,
  DEFAULT_KNOWLEDGE_EMBEDDING_MODEL,
} from '@/lib/knowledge/types';

export type EmbedManyFn = (values: string[], signal?: AbortSignal) => Promise<number[][]>;
export type EmbedOneFn = (value: string, signal?: AbortSignal) => Promise<number[]>;

function knowledgeEmbeddingModelId() {
  const configured = process.env.KNOWLEDGE_EMBEDDING_MODEL?.trim();
  return configured ?? DEFAULT_KNOWLEDGE_EMBEDDING_MODEL;
}

function knowledgeEmbeddingDimensions() {
  const raw = process.env.KNOWLEDGE_EMBEDDING_DIMENSIONS?.trim();
  if (!raw) return DEFAULT_KNOWLEDGE_EMBEDDING_DIMENSIONS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('KNOWLEDGE_EMBEDDING_DIMENSIONS must be a positive integer');
  }
  return parsed;
}

export function openRouterEmbedders(apiKey: string): {
  embedMany: EmbedManyFn;
  embedOne: EmbedOneFn;
} {
  const provider = createOpenRouter({ apiKey });
  const model = provider.textEmbeddingModel(knowledgeEmbeddingModelId());
  const dimensions = knowledgeEmbeddingDimensions();

  return {
    embedMany: async (values, signal) => {
      if (!values.length) return [];
      const result = await embedMany({
        model,
        values,
        dimensions,
        maxRetries: 0,
        abortSignal: signal,
      });
      return result.embeddings;
    },
    embedOne: async (value, signal) => {
      const result = await embed({
        model,
        value,
        dimensions,
        maxRetries: 0,
        abortSignal: signal,
      });
      return result.embedding;
    },
  };
}

/** Deterministic stub embeddings for tests — unit length, content-dependent. */
export function stubEmbedders(dimensions = DEFAULT_KNOWLEDGE_EMBEDDING_DIMENSIONS): {
  embedMany: EmbedManyFn;
  embedOne: EmbedOneFn;
} {
  const one = (value: string): number[] => {
    const vector = Array.from({ length: dimensions }, (_, index) => {
      let hash = index + 1;
      for (let i = 0; i < value.length; i += 1) {
        hash = (hash * 31 + value.charCodeAt(i)) % 10_007;
      }
      return ((hash % 1000) - 500) / 500;
    });
    const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0)) || 1;
    return vector.map((n) => n / norm);
  };
  return {
    embedOne: (value) => Promise.resolve(one(value)),
    embedMany: (values) => Promise.resolve(values.map((value) => one(value))),
  };
}
