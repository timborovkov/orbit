import { compareSnowflake } from '@/lib/runtime/x/fixture';
import { resolveXBearerToken } from '@/lib/runtime/x/settings';
import type {
  XSearchAdapter,
  XSearchAvailability,
  XSearchPost,
  XSearchRequest,
  XSearchResult,
} from '@/lib/runtime/x/types';

const RECENT_SEARCH_URL = 'https://api.x.com/2/tweets/search/recent';

interface TweetPayload {
  id?: string;
  text?: string;
  author_id?: string;
  created_at?: string;
}

interface UserPayload {
  id?: string;
  username?: string;
}

interface SearchResponse {
  data?: TweetPayload[];
  includes?: { users?: UserPayload[] };
  meta?: { newest_id?: string; result_count?: number };
  title?: string;
  detail?: string;
  errors?: { message?: string }[];
}

function newestAmong(posts: XSearchPost[], fallback: string | null): string | null {
  if (posts.length === 0) return fallback;
  return posts.reduce(
    (max, post) => (compareSnowflake(post.id, max) > 0 ? post.id : max),
    posts[0].id,
  );
}

/**
 * X API v2 recent-search adapter. Without X_BEARER_TOKEN, availability reports
 * unavailable and searchRecent throws a clear error — callers must check first.
 */
export function createLiveXSearchAdapter(
  token: string | undefined = resolveXBearerToken(),
): XSearchAdapter {
  const bearer = token?.trim() ? token.trim() : undefined;
  return {
    name: 'x-api',
    availability(): XSearchAvailability {
      if (!bearer) {
        return {
          available: false,
          reason: 'X_BEARER_TOKEN is not set. X discovery polling is unavailable.',
        };
      }
      return { available: true };
    },
    async searchRecent(request: XSearchRequest): Promise<XSearchResult> {
      if (!bearer) {
        throw new Error('X_BEARER_TOKEN is not set. X discovery polling is unavailable.');
      }
      const query = request.query.trim();
      if (!query) return { posts: [], newestId: request.sinceId ?? null };

      const url = new URL(RECENT_SEARCH_URL);
      url.searchParams.set('query', query);
      url.searchParams.set(
        'max_results',
        String(Math.min(Math.max(request.maxResults ?? 10, 10), 100)),
      );
      url.searchParams.set('tweet.fields', 'created_at,author_id');
      url.searchParams.set('expansions', 'author_id');
      url.searchParams.set('user.fields', 'username');
      if (request.sinceId) url.searchParams.set('since_id', request.sinceId);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: 'application/json',
        },
        signal: request.signal,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as SearchResponse;
        const fromErrors = body.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join('; ');
        const detail = body.detail ?? body.title ?? fromErrors ?? response.statusText;
        throw new Error(`X recent search failed (${response.status}): ${detail}`);
      }
      const body = (await response.json()) as SearchResponse;

      const users = new Map(
        (body.includes?.users ?? [])
          .filter((user): user is UserPayload & { id: string } => Boolean(user.id))
          .map((user) => [user.id, user]),
      );
      const posts: XSearchPost[] = (body.data ?? [])
        .filter((tweet): tweet is TweetPayload & { id: string; text: string } =>
          Boolean(tweet.id && tweet.text),
        )
        .map((tweet) => {
          const author = tweet.author_id ? users.get(tweet.author_id) : undefined;
          return {
            id: tweet.id,
            text: tweet.text,
            authorId: tweet.author_id,
            authorUsername: author?.username,
            createdAt: tweet.created_at,
            raw: { ...tweet },
          };
        })
        .sort((a, b) => compareSnowflake(a.id, b.id));

      const newestId = body.meta?.newest_id ?? newestAmong(posts, request.sinceId ?? null);
      return { posts, newestId };
    },
  };
}
