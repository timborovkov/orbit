import { z } from 'zod';

import type { ResearchKeySource } from '@/lib/research';
import { decryptSecret } from '@/lib/runtime/secrets';

export const DEFAULT_FIRECRAWL_ORIGIN = 'https://api.firecrawl.dev';
export const firecrawlKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[\x21-\x7e]+$/);

export function parseFirecrawlEnv(input: Record<string, string | undefined>) {
  const configured = input.FIRECRAWL_API_ORIGIN?.trim();
  const url = URL.parse(configured || DEFAULT_FIRECRAWL_ORIGIN);
  if (
    !url ||
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.href !== url.origin + '/'
  ) {
    throw new Error(
      'FIRECRAWL_API_ORIGIN must be an HTTP(S) origin without a path, query or credentials.',
    );
  }
  const key = input.FIRECRAWL_API_KEY?.trim();
  if (key && !firecrawlKeySchema.safeParse(key).success) {
    throw new Error('FIRECRAWL_API_KEY must be a valid bearer token.');
  }
  return { origin: url.origin, key: key || undefined };
}

export function firecrawlCredentialSubject(agentId: string) {
  return 'firecrawl:' + agentId;
}

export function firecrawlKeySource(hasOverride: boolean): ResearchKeySource {
  const { origin, key } = parseFirecrawlEnv(process.env);
  if (hasOverride) return 'agent';
  if (key) return 'environment';
  return origin === DEFAULT_FIRECRAWL_ORIGIN ? 'missing' : 'keyless';
}

export function resolveFirecrawlConfig(
  agentId: string,
  encryptedKey: string | null | undefined,
  env = parseFirecrawlEnv(process.env),
) {
  return {
    origin: env.origin,
    key: encryptedKey ? decryptSecret(firecrawlCredentialSubject(agentId), encryptedKey) : env.key,
  };
}
