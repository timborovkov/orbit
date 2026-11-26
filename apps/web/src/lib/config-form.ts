import { configSchema } from '@/lib/runtime/config';
import { clampDiscoveryMaxPosts } from '@/lib/runtime/x/discovery-cost';
import { normalizeDiscoveryFilters } from '@/lib/runtime/x/discovery-filters';

function parseFiltersField(raw: FormDataEntryValue | null) {
  if (typeof raw !== 'string' || !raw.trim()) return normalizeDiscoveryFilters(undefined);
  try {
    return normalizeDiscoveryFilters(JSON.parse(raw) as unknown);
  } catch {
    return normalizeDiscoveryFilters(undefined);
  }
}

/** Parse agent/template configuration forms, including multi-value discovery fields. */
export function parseConfigForm(form: FormData, overrides: Record<string, unknown> = {}) {
  const entries = Object.fromEntries(form.entries());
  const queries = form
    .getAll('xSearchQuery')
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 10);

  const pausedRaw = form.get('xDiscoveryPaused');
  const maxRaw = form.get('xDiscoveryMaxPostsPerPoll');
  const maxPosts =
    typeof maxRaw === 'string' && maxRaw.trim()
      ? clampDiscoveryMaxPosts(Number(maxRaw))
      : undefined;
  const filters = parseFiltersField(form.get('xDiscoveryFilters'));

  return configSchema.safeParse({
    ...entries,
    ...overrides,
    xSearchQueries: queries,
    xSearchQuery: queries[0] ?? '',
    xDiscoveryPaused:
      pausedRaw === 'true' ? true : pausedRaw === 'false' ? false : entries.xDiscoveryPaused,
    xDiscoveryFilters: filters,
    ...(maxPosts !== undefined ? { xDiscoveryMaxPostsPerPoll: maxPosts } : {}),
  });
}
