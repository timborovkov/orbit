import {
  evaluateDiscoveryFilters,
  formatFilterSkipReason,
} from '@/lib/runtime/x/discovery-filters/engine';
import { snapshotFromSearchPost } from '@/lib/runtime/x/discovery-filters/snapshot';
import type {
  DiscoveryFilterDecision,
  DiscoveryFilters,
} from '@/lib/runtime/x/discovery-filters/types';
import type { XSearchPost } from '@/lib/runtime/x/types';

export type DiscoveryFilterOutcome = {
  post: XSearchPost;
  decision: DiscoveryFilterDecision;
  skipReason: string | null;
};

export type DiscoveryFilterContext = {
  filters: DiscoveryFilters;
  now?: Date;
  /** Author IDs (provider ids) the agent engaged recently. */
  recentlyEngagedAuthorIds?: ReadonlySet<string>;
};

/** Apply discovery filters before relevance pre-filter / LLM evaluation. */
export function applyDiscoveryFilters(
  posts: readonly XSearchPost[],
  context: DiscoveryFilterContext,
): { kept: XSearchPost[]; rejected: DiscoveryFilterOutcome[]; outcomes: DiscoveryFilterOutcome[] } {
  const now = context.now ?? new Date();
  const outcomes: DiscoveryFilterOutcome[] = [];
  const kept: XSearchPost[] = [];
  const rejected: DiscoveryFilterOutcome[] = [];

  for (const post of posts) {
    const snapshot = snapshotFromSearchPost(post);
    if (context.filters.skipRecentlyEngagedAuthors && post.authorId) {
      snapshot.authorRecentlyEngaged =
        context.recentlyEngagedAuthorIds?.has(post.authorId) === true;
    }
    const decision = evaluateDiscoveryFilters(snapshot, context.filters, now);
    const outcome: DiscoveryFilterOutcome = {
      post,
      decision,
      skipReason: decision.pass ? null : formatFilterSkipReason(decision.reasons),
    };
    outcomes.push(outcome);
    if (decision.pass) kept.push(post);
    else rejected.push(outcome);
  }

  return { kept, rejected, outcomes };
}
