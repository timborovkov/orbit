/** Normalized X (Twitter) post from recent search. */
export interface XSearchPost {
  id: string;
  text: string;
  authorId?: string;
  authorUsername?: string;
  createdAt?: string;
  /** Raw provider payload retained for audit / replay. */
  raw: Record<string, unknown>;
}

export interface XSearchRequest {
  query: string;
  sinceId?: string | null;
  maxResults?: number;
  signal?: AbortSignal;
}

export type XSearchAvailability = { available: true } | { available: false; reason: string };

export interface XSearchResult {
  posts: XSearchPost[];
  /**
   * Newest provider id across the full result set (all pages).
   * Callers advance since_id only after every page has been consumed.
   */
  newestId: string | null;
}

/**
 * Authorized X recent-search adapter. Fixture and live API share this surface.
 * When unavailable, callers record status and skip the network — never throw for
 * a missing token.
 */
export interface XSearchAdapter {
  readonly name: 'fixture' | 'x-api';
  availability(): XSearchAvailability;
  searchRecent(request: XSearchRequest): Promise<XSearchResult>;
}

export const X_PROVIDER = 'x' as const;
export const X_DISCOVERY_POLL_JOB = 'x.discovery.poll';
export const X_DISCOVERY_ACTOR = 'system:x-discovery';
/** Default shadow poll cadence. Tests inject a shorter interval. */
export const X_DISCOVERY_POLL_INTERVAL_MS = 5 * 60 * 1000;
