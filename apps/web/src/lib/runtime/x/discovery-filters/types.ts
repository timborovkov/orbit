/** Typed field registry for deterministic X discovery filters. */

export const DISCOVERY_FILTER_VERSION = 1 as const;

export const DISCOVERY_FILTER_FIELDS = [
  'post.ageHours',
  'post.lang',
  'post.type',
  'post.hasLinks',
  'post.hasMedia',
  'post.likes',
  'post.reposts',
  'post.replies',
  'post.quotes',
  'post.impressions',
  'post.text',
  'author.followers',
  'author.following',
  'author.verified',
  'author.ageDays',
  'author.bio',
  'author.location',
  'author.name',
  'author.handle',
] as const;

export type DiscoveryFilterField = (typeof DISCOVERY_FILTER_FIELDS)[number];

export const DISCOVERY_FILTER_OPS = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'not_in',
  'contains',
  'not_contains',
  'matches_any',
  'matches_none',
  'is_true',
  'is_false',
] as const;

export type DiscoveryFilterOp = (typeof DISCOVERY_FILTER_OPS)[number];

export type DiscoveryPostType = 'original' | 'reply' | 'quote' | 'retweet';

/** Normalized attributes evaluated by the rule engine. */
export type DiscoveryPostSnapshot = {
  id: string;
  text: string;
  createdAt: string | null;
  lang: string | null;
  type: DiscoveryPostType;
  hasLinks: boolean;
  hasMedia: boolean;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  quotes: number | null;
  impressions: number | null;
  authorId: string | null;
  authorHandle: string | null;
  authorName: string | null;
  authorBio: string | null;
  authorLocation: string | null;
  authorVerified: boolean | null;
  authorFollowers: number | null;
  authorFollowing: number | null;
  authorCreatedAt: string | null;
  /** Set by callers that can query engagement history. */
  authorRecentlyEngaged?: boolean;
};

export type DiscoveryFilterRule = {
  field: DiscoveryFilterField;
  op: DiscoveryFilterOp;
  /** Scalar or list depending on the operator. */
  value?: string | number | boolean | string[];
};

export type DiscoveryFilters = {
  version: typeof DISCOVERY_FILTER_VERSION;
  /** Reject posts older than this many hours. Default 2. */
  maxPostAgeHours: number;
  /** When true, skip authors the agent already engaged within the window. */
  skipRecentlyEngagedAuthors: boolean;
  recentlyEngagedWithinHours: number;
  /** AND-combined rules over the field registry. */
  rules: DiscoveryFilterRule[];
};

export type DiscoveryFilterDecision = {
  pass: boolean;
  reasons: string[];
};

/** Operators allowed per field — keeps the UI and engine aligned. */
export const FIELD_OPERATORS: Record<DiscoveryFilterField, readonly DiscoveryFilterOp[]> = {
  'post.ageHours': ['lt', 'lte', 'gt', 'gte'],
  'post.lang': ['eq', 'neq', 'in', 'not_in'],
  'post.type': ['eq', 'neq', 'in', 'not_in'],
  'post.hasLinks': ['is_true', 'is_false'],
  'post.hasMedia': ['is_true', 'is_false'],
  'post.likes': ['lt', 'lte', 'gt', 'gte', 'eq'],
  'post.reposts': ['lt', 'lte', 'gt', 'gte', 'eq'],
  'post.replies': ['lt', 'lte', 'gt', 'gte', 'eq'],
  'post.quotes': ['lt', 'lte', 'gt', 'gte', 'eq'],
  'post.impressions': ['lt', 'lte', 'gt', 'gte', 'eq'],
  'post.text': ['contains', 'not_contains', 'matches_any', 'matches_none'],
  'author.followers': ['lt', 'lte', 'gt', 'gte', 'eq'],
  'author.following': ['lt', 'lte', 'gt', 'gte', 'eq'],
  'author.verified': ['is_true', 'is_false'],
  'author.ageDays': ['lt', 'lte', 'gt', 'gte'],
  'author.bio': ['contains', 'not_contains', 'matches_any', 'matches_none'],
  'author.location': ['contains', 'not_contains', 'matches_any', 'matches_none'],
  'author.name': ['contains', 'not_contains', 'matches_any', 'matches_none'],
  'author.handle': ['eq', 'neq', 'in', 'not_in', 'contains', 'not_contains'],
};

export const FIELD_LABELS: Record<DiscoveryFilterField, string> = {
  'post.ageHours': 'Post age (hours)',
  'post.lang': 'Language',
  'post.type': 'Post type',
  'post.hasLinks': 'Has links',
  'post.hasMedia': 'Has media',
  'post.likes': 'Likes',
  'post.reposts': 'Reposts',
  'post.replies': 'Replies',
  'post.quotes': 'Quotes',
  'post.impressions': 'Impressions',
  'post.text': 'Post text',
  'author.followers': 'Author followers',
  'author.following': 'Author following',
  'author.verified': 'Author verified',
  'author.ageDays': 'Author age (days)',
  'author.bio': 'Author bio',
  'author.location': 'Author location',
  'author.name': 'Author name',
  'author.handle': 'Author handle',
};

export const OP_LABELS: Record<DiscoveryFilterOp, string> = {
  eq: 'equals',
  neq: 'not equals',
  lt: 'less than',
  lte: 'at most',
  gt: 'greater than',
  gte: 'at least',
  in: 'is one of',
  not_in: 'is not one of',
  contains: 'contains',
  not_contains: 'does not contain',
  matches_any: 'matches any',
  matches_none: 'matches none',
  is_true: 'is true',
  is_false: 'is false',
};

/** Default max age: never reply to posts older than two hours. */
export const DEFAULT_MAX_POST_AGE_HOURS = 2;
export const DEFAULT_RECENTLY_ENGAGED_WITHIN_HOURS = 24;

/** Default language gate: English only (admins can clear or change per agent). */
export const DEFAULT_LANGUAGE_RULE: DiscoveryFilterRule = {
  field: 'post.lang',
  op: 'eq',
  value: 'en',
};
