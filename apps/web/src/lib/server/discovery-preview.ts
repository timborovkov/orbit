import 'server-only';

import { desc, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { configSchema } from '@/lib/runtime/config';
import { createXSearchAdapter } from '@/lib/runtime/x/adapter';
import {
  clampDiscoveryMaxPosts,
  X_DISCOVERY_PAGES_PER_QUERY,
} from '@/lib/runtime/x/discovery-cost';
import {
  applyDiscoveryFilters,
  type DiscoveryFilters,
  loadRecentlyEngagedAuthorIds,
  normalizeDiscoveryFilters,
} from '@/lib/runtime/x/discovery-filters';
import { createFixtureXSearchAdapter } from '@/lib/runtime/x/fixture';
import {
  prefilterDiscoveryPosts,
  scoreDiscoveryRelevance,
} from '@/lib/runtime/x/relevance-prefilter';
import { resolveXBearerToken } from '@/lib/runtime/x/settings';
import { agents, configurations } from '@/lib/schema';

type DiscoveryPreviewPost = {
  id: string;
  text: string;
  authorUsername?: string;
  relevant: boolean;
  matchedTerms: string[];
  filterPass: boolean;
  filterReasons: string[];
};

export type DiscoveryPreviewResult = {
  error?: string;
  message?: string;
  posts?: DiscoveryPreviewPost[];
};

/** Sample a query against X without persisting events, cursors or runs. */
export async function previewDiscoveryQuery(input: {
  agentId: string;
  query: string;
  maxPosts?: number;
  /** Optional unsaved filters from the Configuration form. */
  filters?: DiscoveryFilters;
}): Promise<DiscoveryPreviewResult> {
  const maxPosts = clampDiscoveryMaxPosts(input.maxPosts);
  const store = db();
  const [agent] = await store
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, input.agentId));
  if (!agent) return { error: 'Agent not found.' };

  const [version] = await store
    .select({ config: configurations.config })
    .from(configurations)
    .where(eq(configurations.agentId, input.agentId))
    .orderBy(desc(configurations.version))
    .limit(1);
  const parsed = version ? configSchema.safeParse(version.config) : null;
  const config = parsed?.success ? parsed.data : null;
  const filters = normalizeDiscoveryFilters(
    input.filters ?? config?.xDiscoveryFilters ?? undefined,
  );

  const live = createXSearchAdapter(resolveXBearerToken());
  const availability = live.availability();
  const usingFixture = !availability.available;
  const adapter = usingFixture ? createFixtureXSearchAdapter() : live;

  try {
    const search = await adapter.searchRecent({
      query: input.query,
      maxResults: Math.min(Math.max(maxPosts, 10), 100),
      maxPosts,
      maxPages: X_DISCOVERY_PAGES_PER_QUERY,
    });
    // Fixture posts use fixed historical timestamps; refresh them in Test query so
    // age defaults do not hide every sample when X is unavailable.
    const now = Date.now();
    const capped = search.posts.slice(0, maxPosts).map((post, index) => {
      const createdAt = usingFixture
        ? new Date(now - index * 60_000).toISOString()
        : (post.createdAt ?? new Date(now - index * 60_000).toISOString());
      const lang = post.lang ?? 'en';
      return {
        ...post,
        createdAt,
        lang,
        raw: {
          ...post.raw,
          created_at: createdAt,
          lang,
        },
      };
    });
    const authorIds = capped.flatMap((post) => (post.authorId ? [post.authorId] : []));
    const recentlyEngagedAuthorIds = filters.skipRecentlyEngagedAuthors
      ? await store.transaction((tx) =>
          loadRecentlyEngagedAuthorIds(
            tx,
            input.agentId,
            authorIds,
            filters.recentlyEngagedWithinHours,
          ),
        )
      : undefined;
    const filtered = applyDiscoveryFilters(capped, { filters, recentlyEngagedAuthorIds });
    const criteria = {
      mission: config?.mission,
      engagementCriteria: config?.engagementCriteria,
      hints: [input.query],
    };
    const { dropped } = prefilterDiscoveryPosts(filtered.kept, criteria);
    const posts = filtered.outcomes.map((outcome) => {
      const decision = outcome.decision.pass
        ? scoreDiscoveryRelevance(outcome.post.text, criteria)
        : { relevant: false, matchedTerms: [] as string[] };
      return {
        id: outcome.post.id,
        text: outcome.post.text,
        authorUsername: outcome.post.authorUsername,
        relevant: outcome.decision.pass && decision.relevant,
        matchedTerms: decision.matchedTerms,
        filterPass: outcome.decision.pass,
        filterReasons: outcome.decision.pass ? [] : outcome.decision.reasons,
      };
    });
    const filterDropped = filtered.rejected.length;
    const sourceNote = usingFixture
      ? `Fixture samples (${availability.available === false ? availability.reason : 'offline'}). `
      : '';
    return {
      message: `${sourceNote}Sampled ${posts.length} post${posts.length === 1 ? '' : 's'} without saving. ${filterDropped} filtered · ${dropped} failed relevance.`,
      posts,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message.slice(0, 300) : 'X preview search failed.',
    };
  }
}
