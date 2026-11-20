import { createLiveXSearchAdapter } from '@/lib/runtime/x/live';
import { resolveXBearerToken } from '@/lib/runtime/x/settings';
import type { XSearchAdapter } from '@/lib/runtime/x/types';

/**
 * Default production adapter: live X API when a bearer token is configured.
 * Tests and demos inject createFixtureXSearchAdapter instead.
 */
export function createXSearchAdapter(
  token: string | undefined = resolveXBearerToken(),
): XSearchAdapter {
  return createLiveXSearchAdapter(token);
}
