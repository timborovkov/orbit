import { z } from 'zod';

/** Optional X API v2 bearer token. Empty/unset means the live adapter is unavailable. */
export const optionalXBearerToken = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().min(1).max(2048).regex(/^\S+$/).optional(),
);

export function resolveXBearerToken(
  value: string | undefined = process.env.X_BEARER_TOKEN,
): string | undefined {
  return optionalXBearerToken.parse(value);
}
