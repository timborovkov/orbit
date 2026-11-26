import type {
  DiscoveryPostSnapshot,
  DiscoveryPostType,
} from '@/lib/runtime/x/discovery-filters/types';
import type { XSearchPost } from '@/lib/runtime/x/types';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function metricsOf(raw: Record<string, unknown> | null): Record<string, unknown> | null {
  return asRecord(raw?.public_metrics);
}

function referencedTweets(raw: Record<string, unknown> | null): { type?: string }[] {
  const refs = raw?.referenced_tweets;
  if (!Array.isArray(refs)) return [];
  return refs.filter((entry): entry is { type?: string } =>
    Boolean(entry && typeof entry === 'object'),
  );
}

function resolvePostType(raw: Record<string, unknown> | null): DiscoveryPostType {
  const refs = referencedTweets(raw);
  if (refs.some((ref) => ref.type === 'retweeted')) return 'retweet';
  if (refs.some((ref) => ref.type === 'quoted')) return 'quote';
  if (refs.some((ref) => ref.type === 'replied_to')) return 'reply';
  return 'original';
}

function hasLinks(raw: Record<string, unknown> | null, text: string): boolean {
  const entities = asRecord(raw?.entities);
  const urls = entities?.urls;
  if (Array.isArray(urls) && urls.length > 0) return true;
  return /https?:\/\/\S+/i.test(text);
}

function hasMedia(raw: Record<string, unknown> | null): boolean {
  const attachments = asRecord(raw?.attachments);
  const keys = attachments?.media_keys;
  return Array.isArray(keys) && keys.length > 0;
}

function authorFromPost(post: XSearchPost): Record<string, unknown> | null {
  const raw = asRecord(post.raw);
  const included = asRecord(raw?.__author);
  if (included) return included;
  return asRecord(post.author);
}

/**
 * Build a filterable snapshot from a normalized search post.
 * Prefer structured fields on the post; fall back to the retained raw payload.
 */
export function snapshotFromSearchPost(post: XSearchPost): DiscoveryPostSnapshot {
  const raw = asRecord(post.raw) ?? {};
  const author = authorFromPost(post);
  const postMetrics = metricsOf(raw) ?? metricsOf(asRecord(post.metrics) ?? null);
  const authorMetrics = metricsOf(author);

  return {
    id: post.id,
    text: post.text,
    createdAt: post.createdAt ?? asString(raw.created_at),
    lang: post.lang ?? asString(raw.lang),
    type: post.postType ?? resolvePostType(raw),
    hasLinks: post.hasLinks ?? hasLinks(raw, post.text),
    hasMedia: post.hasMedia ?? hasMedia(raw),
    likes: post.metrics?.likeCount ?? asNumber(postMetrics?.like_count),
    reposts: post.metrics?.repostCount ?? asNumber(postMetrics?.retweet_count),
    replies: post.metrics?.replyCount ?? asNumber(postMetrics?.reply_count),
    quotes: post.metrics?.quoteCount ?? asNumber(postMetrics?.quote_count),
    impressions: post.metrics?.impressionCount ?? asNumber(postMetrics?.impression_count),
    authorId: post.authorId ?? asString(raw.author_id) ?? asString(author?.id),
    authorHandle:
      post.authorUsername ?? asString(author?.username) ?? asString(author?.handle) ?? null,
    authorName: post.authorName ?? asString(author?.name),
    authorBio: post.author?.description ?? asString(author?.description),
    authorLocation: post.author?.location ?? asString(author?.location),
    authorVerified:
      post.author?.verified ??
      asBoolean(author?.verified) ??
      asBoolean(author?.verified_type ? author.verified_type !== 'none' : null),
    authorFollowers: post.author?.followersCount ?? asNumber(authorMetrics?.followers_count),
    authorFollowing: post.author?.followingCount ?? asNumber(authorMetrics?.following_count),
    authorCreatedAt: post.author?.createdAt ?? asString(author?.created_at),
  };
}

/** Rebuild a snapshot from a persisted source_events row. */
export function snapshotFromSourceEvent(event: {
  providerEventId: string;
  text: string;
  authorId?: string | null;
  authorUsername?: string | null;
  authorName?: string | null;
  providerCreatedAt?: Date | string | null;
  payload: Record<string, unknown>;
}): DiscoveryPostSnapshot {
  return snapshotFromSearchPost({
    id: event.providerEventId,
    text: event.text,
    authorId: event.authorId ?? undefined,
    authorUsername: event.authorUsername ?? undefined,
    authorName: event.authorName ?? undefined,
    createdAt:
      event.providerCreatedAt instanceof Date
        ? event.providerCreatedAt.toISOString()
        : typeof event.providerCreatedAt === 'string'
          ? event.providerCreatedAt
          : undefined,
    raw: event.payload,
  });
}
