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
/** Safety cap so a runaway next_token cannot loop forever. */
export const X_RECENT_SEARCH_MAX_PAGES = 5;

interface TweetPayload {
  id?: string;
  text?: string;
  author_id?: string;
  conversation_id?: string;
  created_at?: string;
}

interface UserPayload {
  id?: string;
  username?: string;
  name?: string;
}

interface SearchResponse {
  data?: TweetPayload[];
  includes?: { users?: UserPayload[] };
  meta?: {
    newest_id?: string;
    oldest_id?: string;
    result_count?: number;
    next_token?: string;
  };
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

function mapPage(body: SearchResponse): XSearchPost[] {
  const users = new Map(
    (body.includes?.users ?? [])
      .filter((user): user is UserPayload & { id: string } => Boolean(user.id))
      .map((user) => [user.id, user]),
  );
  return (body.data ?? [])
    .filter((tweet): tweet is TweetPayload & { id: string; text: string } =>
      Boolean(tweet.id && tweet.text),
    )
    .map((tweet) => {
      const author = tweet.author_id ? users.get(tweet.author_id) : undefined;
      return {
        id: tweet.id,
        text: tweet.text,
        conversationId: tweet.conversation_id,
        authorId: tweet.author_id,
        authorUsername: author?.username,
        authorName: author?.name,
        createdAt: tweet.created_at,
        raw: { ...tweet },
      };
    });
}

/**
 * X API v2 recent-search adapter. Without X_BEARER_TOKEN, availability reports
 * unavailable and searchRecent throws a clear error — callers must check first.
 * Walks `meta.next_token` pages before returning so since_id does not skip older matches.
 */
export function createLiveXSearchAdapter(
  token: string | undefined = resolveXBearerToken(),
  fetchImpl: typeof fetch = fetch,
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

      const maxResults = Math.min(Math.max(request.maxResults ?? 10, 10), 100);

      const fetchPages = async (
        paginationToken: string | undefined,
        pages: number,
        collected: XSearchPost[],
        newestId: string | null,
      ): Promise<{ posts: XSearchPost[]; newestId: string | null }> => {
        request.signal?.throwIfAborted();
        const url = new URL(RECENT_SEARCH_URL);
        url.searchParams.set('query', query);
        url.searchParams.set('max_results', String(maxResults));
        url.searchParams.set('tweet.fields', 'created_at,author_id,conversation_id');
        url.searchParams.set('expansions', 'author_id');
        url.searchParams.set('user.fields', 'username,name');
        if (request.sinceId) url.searchParams.set('since_id', request.sinceId);
        if (paginationToken) url.searchParams.set('pagination_token', paginationToken);

        const response = await fetchImpl(url, {
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
        const pagePosts = mapPage(body);
        const nextCollected = [...collected, ...pagePosts];
        let nextNewest = newestId;
        if (body.meta?.newest_id) {
          if (!nextNewest || compareSnowflake(body.meta.newest_id, nextNewest) > 0) {
            nextNewest = body.meta.newest_id;
          }
        }
        const nextToken = body.meta?.next_token;
        if (nextToken && pages + 1 < X_RECENT_SEARCH_MAX_PAGES) {
          return fetchPages(nextToken, pages + 1, nextCollected, nextNewest);
        }
        return { posts: nextCollected, newestId: nextNewest };
      };

      const { posts: collected, newestId } = await fetchPages(
        undefined,
        0,
        [],
        request.sinceId ?? null,
      );
      // Dedupe by id across pages (provider may overlap near boundaries).
      const unique = new Map<string, XSearchPost>();
      for (const post of collected) unique.set(post.id, post);
      const deduped = [...unique.values()].sort((a, b) => compareSnowflake(a.id, b.id));
      return {
        posts: deduped,
        newestId: newestId ?? newestAmong(deduped, request.sinceId ?? null),
      };
    },
  };
}
