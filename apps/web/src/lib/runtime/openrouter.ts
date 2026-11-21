import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, isStepCount, Output } from 'ai';
import { z } from 'zod';

import {
  decisionSchema,
  groundedDecisionSchema,
  type InferenceQuote,
  type ModelCall,
  relationshipDecisionSchema,
} from '@/lib/runtime/simulation';

const maxOutputTokens = 3000;
const microsPerDollar = 1_000_000;
const rate = z
  .string()
  .regex(/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i)
  .transform(Number)
  .pipe(z.number().min(0).max(1));
const endpoint = z.object({
  tag: z.string().regex(/^[\w/-]+$/),
  context_length: z.number().int().positive().max(10_000_000),
  supported_parameters: z.array(z.string()),
  pricing: z.object({
    prompt: rate,
    completion: rate,
    request: rate.optional(),
    input_cache_read: rate.optional(),
    input_cache_write: rate.optional(),
  }),
});
const modelEndpoints = z.object({ data: z.object({ endpoints: z.array(z.unknown()) }) });

async function quoteOpenRouter(
  model: string,
  signal: AbortSignal,
  options?: { requireTools?: boolean },
): Promise<InferenceQuote | undefined> {
  // Router aliases and suffixes can select a model with different pricing.
  if (!/^[\w.-]+\/[\w.-]+$/.test(model)) return;
  try {
    const response = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      cache: 'no-store',
    });
    if (!response.ok) return;
    const { data } = modelEndpoints.parse(await response.json());
    const quotes = data.endpoints.flatMap((entry) => {
      const result = endpoint.safeParse(entry);
      if (!result.success) return [];
      const { tag, context_length, pricing, supported_parameters } = result.data;
      const supported = new Set(supported_parameters);
      if (!supported.has('structured_outputs') || !supported.has('max_tokens')) {
        return [];
      }
      // Tool-bearing main stages pin `only` + require_parameters; skip endpoints without tools.
      if (options?.requireTools && !supported.has('tools')) {
        return [];
      }
      // The context window bounds billed input without trusting a local tokenizer.
      const inputRate = Math.max(
        pricing.prompt,
        pricing.input_cache_read ?? 0,
        pricing.input_cache_write ?? 0,
      );
      const requestRate = pricing.request ?? 0;
      return [
        {
          endpoint: tag,
          upperBoundMicros: Math.ceil(
            (context_length * inputRate + maxOutputTokens * pricing.completion + requestRate) *
              microsPerDollar,
          ),
          maxPrice: {
            prompt: pricing.prompt * microsPerDollar,
            completion: pricing.completion * microsPerDollar,
            request: requestRate,
          },
        },
      ];
    });
    return quotes.sort((a, b) => a.upperBoundMicros - b.upperBoundMicros)[0];
  } catch {
    return undefined;
  }
}

export function openRouterInference(apiKey: string): ModelCall {
  const provider = createOpenRouter({ apiKey });
  const call: ModelCall = async (request) => {
    const {
      model,
      system,
      summarizeRelationship,
      input,
      signal,
      quote,
      tools,
      maxToolSteps,
      beforeProviderCall,
      telemetry,
    } = request;
    const hasTools = Boolean(tools && Object.keys(tools).length);
    const toolSteps = maxToolSteps ?? 10;
    const schema = summarizeRelationship
      ? relationshipDecisionSchema
      : request.grounded
        ? groundedDecisionSchema
        : decisionSchema;
    const response = await generateText({
      model: provider(model, {
        usage: { include: true },
        provider: quote
          ? {
              only: [quote.endpoint],
              allow_fallbacks: false,
              require_parameters: true,
              max_price: quote.maxPrice,
            }
          : undefined,
      }),
      instructions: system,
      prompt: input,
      tools: hasTools ? tools : undefined,
      // Structured output counts as a step; leave room for tool calls when attached.
      stopWhen: hasTools ? isStepCount(toolSteps + 1) : undefined,
      prepareStep: async ({ stepNumber }) => {
        signal.throwIfAborted();
        await beforeProviderCall?.(stepNumber);
        if (hasTools && stepNumber >= toolSteps) return { activeTools: [] };
      },
      output: Output.object({ schema }),
      maxOutputTokens,
      maxRetries: 0,
      abortSignal: signal,
      telemetry: telemetry ?? { isEnabled: false },
    });
    const { relationshipNote, ...decision } = response.output as typeof response.output & {
      relationshipNote?: ReturnType<typeof relationshipDecisionSchema.parse>['relationshipNote'];
    };
    return {
      decision,
      relationshipNote,
      inputTokens: response.usage.inputTokens ?? 0,
      outputTokens: response.usage.outputTokens ?? 0,
      // Only bill a complete sum — partial metadata would release reserved spend for unpriced steps.
      costMicros: costMicrosFromSteps(response.steps),
      providerCalls: Math.max(1, response.steps.length),
    };
  };
  call.quote = quoteOpenRouter;
  return call;
}

const stepCostSchema = z.object({
  usage: z.object({
    cost: z
      .number()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER / microsPerDollar),
  }),
});

/** Sum OpenRouter step costs only when every step has valid cost metadata. */
export function costMicrosFromSteps(
  steps: readonly { providerMetadata?: unknown }[],
): number | undefined {
  if (!steps.length) return undefined;
  let costDollars = 0;
  for (const step of steps) {
    const metadata =
      step.providerMetadata &&
      typeof step.providerMetadata === 'object' &&
      'openrouter' in step.providerMetadata
        ? (step.providerMetadata as { openrouter?: unknown }).openrouter
        : undefined;
    const parsed = stepCostSchema.safeParse(metadata);
    if (!parsed.success) return undefined;
    costDollars += parsed.data.usage.cost;
  }
  return Math.ceil(costDollars * microsPerDollar);
}
