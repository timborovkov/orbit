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

/** Fields needed for discovery filters without unused expansions. */
const X_DISCOVERY_TWEET_FIELDS =
  'created_at,author_id,conversation_id,public_metrics,lang,referenced_tweets,entities,attachments';
const X_DISCOVERY_USER_FIELDS =
  'username,name,created_at,public_metrics,verified,description,location';

interface TweetMetrics {
  like_count?: number;
  retweet_count?: number;
  reply_count?: number;
  quote_count?: number;
  impression_count?: number;
}

interface TweetPayload {
  id?: string;
  text?: string;
  author_id?: string;
  conversation_id?: string;
  created_at?: string;
  lang?: string;
  public_metrics?: TweetMetrics;
  referenced_tweets?: { type?: string; id?: string }[];
  entities?: { urls?: unknown[] };
  attachments?: { media_keys?: string[] };
}

interface UserPayload {
  id?: string;
  username?: string;
  name?: string;
  created_at?: string;
  description?: string;
  location?: string;
  verified?: boolean;
  public_metrics?: {
    followers_count?: number;
    following_count?: number;
  };
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

function resolvePostType(refs: { type?: string }[] | undefined): XSearchPost['postType'] {
  if (!refs?.length) return 'original';
  if (refs.some((ref) => ref.type === 'retweeted')) return 'retweet';
  if (refs.some((ref) => ref.type === 'quoted')) return 'quote';
  if (refs.some((ref) => ref.type === 'replied_to')) return 'reply';
  return 'original';
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
      const metrics = tweet.public_metrics;
      return {
        id: tweet.id,
        text: tweet.text,
        conversationId: tweet.conversation_id,
        authorId: tweet.author_id,
        authorUsername: author?.username,
        authorName: author?.name,
        createdAt: tweet.created_at,
        lang: tweet.lang,
        postType: resolvePostType(tweet.referenced_tweets),
        hasLinks: Boolean(tweet.entities?.urls?.length) || /https?:\/\/\S+/i.test(tweet.text),
        hasMedia: Boolean(tweet.attachments?.media_keys?.length),
        metrics: metrics
          ? {
              likeCount: metrics.like_count ?? null,
              repostCount: metrics.retweet_count ?? null,
              replyCount: metrics.reply_count ?? null,
              quoteCount: metrics.quote_count ?? null,
              impressionCount: metrics.impression_count ?? null,
            }
          : undefined,
        author: author
          ? {
              description: author.description ?? null,
              location: author.location ?? null,
              verified: author.verified ?? null,
              followersCount: author.public_metrics?.followers_count ?? null,
              followingCount: author.public_metrics?.following_count ?? null,
              createdAt: author.created_at ?? null,
            }
          : undefined,
        // Embed author so persisted payloads can rebuild filter snapshots.
        raw: { ...tweet, ...(author ? { __author: author } : {}) },
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
      const maxPages = Math.min(
        Math.max(Math.floor(request.maxPages ?? X_RECENT_SEARCH_MAX_PAGES), 1),
        X_RECENT_SEARCH_MAX_PAGES,
      );
      const maxPosts = request.maxPosts && request.maxPosts > 0 ? request.maxPosts : undefined;

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
        url.searchParams.set('tweet.fields', X_DISCOVERY_TWEET_FIELDS);
        url.searchParams.set('expansions', 'author_id');
        url.searchParams.set('user.fields', X_DISCOVERY_USER_FIELDS);
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
        const limitReached = maxPosts !== undefined && nextCollected.length >= maxPosts;
        if (nextToken && !limitReached && pages + 1 < maxPages) {
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
