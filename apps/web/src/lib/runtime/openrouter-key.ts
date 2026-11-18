import { z } from 'zod';

import { MissingOpenRouterCredentialError } from '@/lib/runtime/errors';
import { decryptCredential } from '@/lib/runtime/secrets';

const environmentKeySchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .string()
    .trim()
    .min(1)
    .max(512)
    .refine((value) => !/\s/.test(value))
    .optional(),
);

export type OpenRouterKeySource = 'agent' | 'environment' | 'none';

/** Reads the optional server default. Does not require ORBIT_ENCRYPTION_KEY. */
export function environmentOpenRouterKey(): string | undefined {
  const parsed = environmentKeySchema.safeParse(process.env.OPENROUTER_API_KEY);
  return parsed.success ? parsed.data : undefined;
}

export function openRouterKeySource(hasAgentCredential: boolean): OpenRouterKeySource {
  if (hasAgentCredential) return 'agent';
  if (environmentOpenRouterKey()) return 'environment';
  return 'none';
}

export function openRouterConnectionLabel(keySource: OpenRouterKeySource) {
  if (keySource === 'agent') return 'OpenRouter agent key';
  if (keySource === 'environment') return 'OpenRouter environment default';
  return 'OpenRouter not connected';
}

/**
 * Prefer the agent's encrypted key; otherwise use OPENROUTER_API_KEY.
 * Rotating the env var takes effect without rewriting agent credentials.
 */
export function resolveOpenRouterApiKey(
  agentId: string,
  encryptedAgentKey: string | null | undefined,
): { apiKey: string; source: Exclude<OpenRouterKeySource, 'none'> } {
  if (encryptedAgentKey) {
    return { apiKey: decryptCredential(agentId, encryptedAgentKey), source: 'agent' };
  }
  const apiKey = environmentOpenRouterKey();
  if (apiKey) return { apiKey, source: 'environment' };
  throw new MissingOpenRouterCredentialError();
}
