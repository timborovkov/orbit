import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { embed, embedMany } from 'ai';
import { z } from 'zod';

import {
  DEFAULT_KNOWLEDGE_EMBEDDING_DIMENSIONS,
  DEFAULT_KNOWLEDGE_EMBEDDING_MODEL,
} from '@/lib/knowledge/types';
import { reserveRequestQuota } from '@/lib/policy/gateway';

export type EmbedManyFn = (values: string[], signal?: AbortSignal) => Promise<number[][]>;
export type EmbedOneFn = (value: string, signal?: AbortSignal) => Promise<number[]>;

export function knowledgeUsesStub() {
  return process.env.NODE_ENV !== 'production' && process.env.KNOWLEDGE_EMBEDDING_STUB === 'true';
}

export function knowledgeEmbeddingModelId() {
  const configured = process.env.KNOWLEDGE_EMBEDDING_MODEL?.trim() ?? '';
  const model = configured === '' ? DEFAULT_KNOWLEDGE_EMBEDDING_MODEL : configured;
  return knowledgeUsesStub() ? `stub:${model}` : model;
}

export function knowledgeEmbeddingDimensions() {
  const raw = process.env.KNOWLEDGE_EMBEDDING_DIMENSIONS?.trim();
  if (!raw) return DEFAULT_KNOWLEDGE_EMBEDDING_DIMENSIONS;
  const parsed = Number(raw);
  if (parsed !== DEFAULT_KNOWLEDGE_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `KNOWLEDGE_EMBEDDING_DIMENSIONS must be ${DEFAULT_KNOWLEDGE_EMBEDDING_DIMENSIONS}`,
    );
  }
  return parsed;
}

export function validateKnowledgeVector(vector: number[], dimensions: number) {
  if (vector.length !== dimensions || !vector.every(Number.isFinite) || !vector.some(Boolean)) {
    throw new Error('Embedding provider returned an invalid vector for the configured width.');
  }
  return vector;
}

/** Cache identity for reusable vectors — content alone is not enough across model changes. */
export function knowledgeEmbeddingReuseKey(
  chunkIndex: number,
  contentHash: string,
  model: string,
  dimensions: number,
) {
  return `${chunkIndex}:${contentHash}:${model}:${dimensions}`;
}

const microsPerDollar = 1_000_000;
const rate = z
  .string()
  .regex(/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i)
  .transform(Number)
  .pipe(z.number().min(0).max(1));
const embeddingEndpoints = z.object({ data: z.object({ endpoints: z.array(z.unknown()) }) });
const embeddingEndpoint = z.object({
  tag: z.string().regex(/^[\w/-]+$/),
  context_length: z.number().int().positive().max(10_000_000),
  pricing: z.object({
    prompt: rate,
    request: rate.optional(),
    input_cache_read: rate.optional(),
    input_cache_write: rate.optional(),
  }),
});

async function quoteEmbedding(model: string, signal: AbortSignal) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(model)) return;
  try {
    const response = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      cache: 'no-store',
    });
    if (!response.ok) return;
    const { data } = embeddingEndpoints.parse(await response.json());
    return data.endpoints
      .flatMap((entry) => {
        const result = embeddingEndpoint.safeParse(entry);
        if (!result.success) return [];
        const { tag, context_length, pricing } = result.data;
        return [
          {
            endpoint: tag,
            prompt: pricing.prompt,
            context: context_length,
            inputRate: Math.max(
              pricing.prompt,
              pricing.input_cache_read ?? 0,
              pricing.input_cache_write ?? 0,
            ),
            request: pricing.request ?? 0,
          },
        ];
      })
      .sort((a, b) => a.context * a.inputRate + a.request - (b.context * b.inputRate + b.request))
      .at(0);
  } catch {
    return;
  }
}

export function openRouterEmbedders(
  apiKey: string,
  agentId: string | null,
  execution?: Omit<NonNullable<Parameters<typeof reserveRequestQuota>[2]>, 'stage'>,
): {
  embedMany: EmbedManyFn;
  embedOne: EmbedOneFn;
} {
  const provider = createOpenRouter({ apiKey });
  const modelId = knowledgeEmbeddingModelId();
  const dimensions = knowledgeEmbeddingDimensions();
  let quote: Awaited<ReturnType<typeof quoteEmbedding>>;
  let quoteExpires = 0;

  async function prepare(count: number, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(120_000);
    const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    abortSignal.throwIfAborted();
    if (Date.now() >= quoteExpires) {
      quote = await quoteEmbedding(modelId, abortSignal);
      quoteExpires = Date.now() + 60_000;
    }
    abortSignal.throwIfAborted();
    const limit =
      quote &&
      Math.ceil((quote.context * count * quote.inputRate + quote.request) * microsPerDollar);
    const model = provider.textEmbeddingModel(modelId, {
      extraBody: { dimensions },
      provider: quote
        ? {
            only: [quote.endpoint],
            allow_fallbacks: false,
            max_price: { prompt: quote.prompt * microsPerDollar, request: quote.request },
          }
        : undefined,
    });
    const settle = agentId ? await reserveRequestQuota(agentId, limit, execution) : undefined;
    if (abortSignal.aborted) {
      await settle?.(0);
      abortSignal.throwIfAborted();
    }
    return { model, abortSignal, settle };
  }

  const billedUsage = z.object({
    usage: z.object({
      cost: z
        .number()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER / microsPerDollar),
    }),
  });
  async function settleResponse(metadata: unknown, settle?: (costMicros: number) => Promise<void>) {
    if (!settle) return;
    const actual = billedUsage.safeParse(metadata);
    if (actual.success) {
      try {
        await settle(Math.ceil(actual.data.usage.cost * microsPerDollar));
      } catch {
        // Keep the conservative reservation. A settlement fault must not repeat the paid call.
        console.warn('OpenRouter embedding cost settlement failed', { agentId });
      }
    }
  }

  return {
    embedMany: async (values, signal) => {
      if (!values.length) return [];
      const { model, abortSignal, settle } = await prepare(values.length, signal);
      const result = await embedMany({
        model,
        values,
        dimensions,
        maxRetries: 0,
        abortSignal,
      });
      await settleResponse(result.providerMetadata?.openrouter, settle);
      return result.embeddings.map((vector) => validateKnowledgeVector(vector, dimensions));
    },
    embedOne: async (value, signal) => {
      const { model, abortSignal, settle } = await prepare(1, signal);
      const result = await embed({
        model,
        value,
        dimensions,
        maxRetries: 0,
        abortSignal,
      });
      await settleResponse(result.providerMetadata?.openrouter, settle);
      return validateKnowledgeVector(result.embedding, dimensions);
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
