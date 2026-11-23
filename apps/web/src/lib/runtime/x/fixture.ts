import type {
  XSearchAdapter,
  XSearchPost,
  XSearchRequest,
  XSearchResult,
} from '@/lib/runtime/x/types';

/** Deterministic fixture posts used by unit/integration tests and local demos. */
export const FIXTURE_X_POSTS: XSearchPost[] = [
  {
    id: '1001',
    text: 'Looking for a work-history product that helps teams see what changed and why. Any recommendations?',
    authorId: 'u-100',
    authorUsername: 'ops_lead',
    createdAt: '2026-11-18T10:00:00.000Z',
    raw: { id: '1001', text: 'Looking for a work-history product…', fixture: true },
  },
  {
    id: '1002',
    text: 'We need better audit trails across our delivery tools. What are people using for timeline-style history?',
    authorId: 'u-101',
    authorUsername: 'eng_manager',
    createdAt: '2026-11-18T11:30:00.000Z',
    raw: { id: '1002', text: 'We need better audit trails…', fixture: true },
  },
  {
    id: '1003',
    text: 'Random lunch spam — ignore me.',
    authorId: 'u-102',
    authorUsername: 'noise_bot',
    createdAt: '2026-11-18T12:00:00.000Z',
    raw: { id: '1003', text: 'Random lunch spam…', fixture: true },
  },
];

/** A single post addressed to the demo replying account. */
export const FIXTURE_X_REPLY_POST: XSearchPost = {
  id: '1001',
  text: '@orbit_fixture Looking for a work-history product. Could you tell me about yours?',
  authorId: '12001',
  authorUsername: 'ops_lead',
  raw: { id: '1001', fixture: true },
};

function newestAmong(posts: XSearchPost[], fallback: string | null): string | null {
  if (posts.length === 0) return fallback;
  return posts.reduce(
    (max, post) => (compareSnowflake(post.id, max) > 0 ? post.id : max),
    posts[0].id,
  );
}

/**
 * In-memory X recent-search adapter. Honours since_id so repeated polls and
 * restarts can be proven without network access.
 */
export function createFixtureXSearchAdapter(
  posts: XSearchPost[] = FIXTURE_X_POSTS,
): XSearchAdapter {
  const ordered = [...posts].sort((a, b) => compareSnowflake(a.id, b.id));
  return {
    name: 'fixture',
    availability: () => ({ available: true }),
    searchRecent(request: XSearchRequest): Promise<XSearchResult> {
      request.signal?.throwIfAborted();
      const query = request.query.trim().toLowerCase();
      const matched = ordered.filter((post) => {
        if (request.sinceId && compareSnowflake(post.id, request.sinceId) <= 0) return false;
        if (!query) return true;
        return post.text.toLowerCase().includes(query) || query === '*';
      });
      const limited = matched.slice(0, request.maxResults ?? 10);
      return Promise.resolve({
        posts: limited,
        newestId: newestAmong(limited, request.sinceId ?? null),
      });
    },
  };
}

/** Compare X snowflake ids as decimal strings without Number precision loss. */
export function compareSnowflake(a: string, b: string): number {
  const left = a.replace(/^0+/, '') || '0';
  const right = b.replace(/^0+/, '') || '0';
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}
