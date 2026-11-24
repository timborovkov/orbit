/**
 * Operator-facing cost hints for X discovery polling.
 * X recent-search pricing is not billed through Orbit; this estimates request volume only.
 */

export const X_DISCOVERY_DEFAULT_MAX_POSTS = 10;
const X_DISCOVERY_MAX_POSTS_HARD_CAP = 50;
/** Discovery polls fetch one page per query; the live adapter enforces this bound. */
export const X_DISCOVERY_PAGES_PER_QUERY = 1;

export function clampDiscoveryMaxPosts(value: number | undefined | null): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return X_DISCOVERY_DEFAULT_MAX_POSTS;
  }
  return Math.max(1, Math.min(Math.floor(value), X_DISCOVERY_MAX_POSTS_HARD_CAP));
}

/** Upper bound on X recent-search HTTP requests for one poll. */
export function estimateDiscoverySearchRequests(options: { queryCount: number }): number {
  const queries = Math.max(0, Math.floor(options.queryCount));
  return queries * X_DISCOVERY_PAGES_PER_QUERY;
}

/** Short hint shown next to Discovery settings. */
export function discoveryCostHint(options: {
  queryCount: number;
  maxPostsPerPoll: number;
  paused: boolean;
}): string {
  if (options.paused) {
    return 'Polling is paused. No X search requests until you resume.';
  }
  if (options.queryCount <= 0) {
    return 'Add a query and turn polling on to start searching X.';
  }
  const requests = estimateDiscoverySearchRequests({ queryCount: options.queryCount });
  const queryLabel = options.queryCount === 1 ? '1 query' : `${options.queryCount} queries`;
  return `Each poll may use up to ${requests} X search request${requests === 1 ? '' : 's'} (${queryLabel}, cap ${clampDiscoveryMaxPosts(options.maxPostsPerPoll)} posts). Full agent runs still count against the daily request quota.`;
}
