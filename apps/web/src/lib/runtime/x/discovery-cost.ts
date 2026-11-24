/**
 * Operator-facing cost hints for X discovery polling.
 * X recent-search pricing is not billed through Orbit; this estimates request volume only.
 */

export const X_DISCOVERY_DEFAULT_MAX_POSTS = 10;
const X_DISCOVERY_MAX_POSTS_HARD_CAP = 50;
/** Rough upper bound: live adapter walks up to 5 pages; each page is one API call. */
const X_DISCOVERY_MAX_PAGES_PER_QUERY = 5;

export function clampDiscoveryMaxPosts(value: number | undefined | null): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return X_DISCOVERY_DEFAULT_MAX_POSTS;
  }
  return Math.max(1, Math.min(Math.floor(value), X_DISCOVERY_MAX_POSTS_HARD_CAP));
}

/**
 * Estimate how many X recent-search HTTP requests one poll may use.
 * Each query walks pages until the post cap is filled or page limit is hit.
 */
export function estimateDiscoverySearchRequests(options: {
  queryCount: number;
  maxPostsPerPoll: number;
  pageSize?: number;
}): number {
  const queries = Math.max(0, Math.floor(options.queryCount));
  if (queries === 0) return 0;
  const pageSize = Math.max(10, options.pageSize ?? 10);
  const posts = clampDiscoveryMaxPosts(options.maxPostsPerPoll);
  const pagesPerQuery = Math.min(
    X_DISCOVERY_MAX_PAGES_PER_QUERY,
    Math.max(1, Math.ceil(posts / pageSize)),
  );
  return queries * pagesPerQuery;
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
  const requests = estimateDiscoverySearchRequests(options);
  const queryLabel = options.queryCount === 1 ? '1 query' : `${options.queryCount} queries`;
  return `Each poll may use up to ${requests} X search request${requests === 1 ? '' : 's'} (${queryLabel}, cap ${clampDiscoveryMaxPosts(options.maxPostsPerPoll)} posts). Full agent runs still count against the daily request quota.`;
}
