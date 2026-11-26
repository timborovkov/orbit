/** Shared console chrome helpers (pure; safe for unit tests). */

const CONSOLE_NAV_HREFS = [
  '/',
  '/approvals',
  '/people',
  '/evaluations',
  '/templates',
  '/knowledge',
  '/skills',
  '/mcp',
] as const;

export type ConsoleNavHref = (typeof CONSOLE_NAV_HREFS)[number];

/** Light poll so worker-created proposals update the badge without a full reload. */
export const PENDING_APPROVAL_COUNT_POLL_MS = 30_000;

export function currentConsoleNavFromPath(pathname: string): ConsoleNavHref | undefined {
  if (pathname === '/') return '/';
  return CONSOLE_NAV_HREFS.find((href) => href !== '/' && pathname.startsWith(href));
}

/**
 * Prefer a live fetch over the server-rendered seed. When the layout soft-refreshes
 * and supplies a newer seed, that seed wins until the next live fetch.
 */
export function resolvedPendingApprovalCount(
  serverCount: number,
  liveCount: number | null,
  liveForServerCount: number | null,
): number {
  if (liveCount !== null && liveForServerCount === serverCount) return liveCount;
  return serverCount;
}
