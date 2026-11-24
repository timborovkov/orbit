import { z } from 'zod';

import {
  clampDiscoveryMaxPosts,
  X_DISCOVERY_DEFAULT_MAX_POSTS,
} from '@/lib/runtime/x/discovery-cost';

const prose = z.string().trim().max(12000);
const model = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[\w./:@+-]+$/);

const searchQuery = z.string().trim().min(1).max(512);

/**
 * Normalize legacy `xSearchQuery` string into `xSearchQueries` array and clamp poll caps.
 * Existing configuration JSON remains readable without a DB migration.
 */
function normalizeDiscoveryConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const input = raw as Record<string, unknown>;
  const next: Record<string, unknown> = { ...input };

  if (!Array.isArray(next.xSearchQueries)) {
    const legacy = typeof next.xSearchQuery === 'string' ? next.xSearchQuery.trim() : '';
    next.xSearchQueries = legacy ? [legacy] : [];
  } else {
    next.xSearchQueries = (next.xSearchQueries as unknown[])
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 10);
  }

  // Keep a derived single-string field for older readers / snapshots.
  const queries = next.xSearchQueries as string[];
  next.xSearchQuery = queries[0] ?? '';

  if (typeof next.xDiscoveryPaused !== 'boolean') {
    next.xDiscoveryPaused = false;
  }

  next.xDiscoveryMaxPostsPerPoll = clampDiscoveryMaxPosts(
    typeof next.xDiscoveryMaxPostsPerPoll === 'number'
      ? next.xDiscoveryMaxPostsPerPoll
      : X_DISCOVERY_DEFAULT_MAX_POSTS,
  );

  return next;
}

export const configSchema = z.preprocess(
  normalizeDiscoveryConfig,
  z.object({
    name: z.string().trim().min(1).max(80),
    role: prose,
    personality: prose,
    mission: z.string().trim().max(2000),
    instructions: prose,
    engagementCriteria: prose,
    /**
     * Admin-authored X recent-search queries (up to 10).
     * Empty list disables discovery polling. Legacy single `xSearchQuery` is mapped in.
     */
    xSearchQueries: z.array(searchQuery).max(10).default([]),
    /** Derived first query for compatibility with templates and older snapshots. */
    xSearchQuery: z.string().trim().max(512).default(''),
    /** When true, keep queries but skip live polling until resumed. */
    xDiscoveryPaused: z.boolean().default(false),
    /** Soft cap on posts persisted/evaluated per poll across all queries. */
    xDiscoveryMaxPostsPerPoll: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(X_DISCOVERY_DEFAULT_MAX_POSTS),
    mainModel: model,
    evaluatorModel: model,
  }),
);
export type AgentConfig = z.infer<typeof configSchema>;

export function discoveryQueries(
  config: Pick<AgentConfig, 'xSearchQueries' | 'xSearchQuery'>,
): string[] {
  if (config.xSearchQueries.length) return config.xSearchQueries;
  const legacy = config.xSearchQuery.trim();
  return legacy ? [legacy] : [];
}

export const configFields = [
  ['name', 'Name'],
  ['role', 'Role'],
  ['personality', 'Personality'],
  ['mission', 'Mission'],
  ['instructions', 'Operating instructions'],
  ['engagementCriteria', 'Engagement criteria'],
  ['xSearchQuery', 'X search query'],
  ['mainModel', 'Main model'],
  ['evaluatorModel', 'Evaluator model'],
] as const;
