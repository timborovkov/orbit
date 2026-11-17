import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, Output } from 'ai';

import { decisionSchema, type ModelCall } from '@/lib/runtime/simulation';

export function openRouterInference(apiKey: string): ModelCall {
  const provider = createOpenRouter({ apiKey });
  return async ({ model, system, input, signal }) => {
    const response = await generateText({
      model: provider(model),
      instructions: system,
      prompt: input,
      output: Output.object({ schema: decisionSchema }),
      maxOutputTokens: 3000,
      maxRetries: 0,
      abortSignal: signal,
      telemetry: { isEnabled: false },
    });
    return {
      decision: response.output,
      inputTokens: response.usage.inputTokens ?? 0,
      outputTokens: response.usage.outputTokens ?? 0,
    };
  };
}
