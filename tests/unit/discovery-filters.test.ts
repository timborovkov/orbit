import { expect, test } from 'bun:test';

import { configSchema, discoverySettings } from '@/lib/runtime/config';
import {
  applyDiscoveryFilters,
  DEFAULT_LANGUAGE_RULE,
  DEFAULT_MAX_POST_AGE_HOURS,
  defaultDiscoveryFilters,
  type DiscoveryFilters,
  type DiscoveryPostSnapshot,
  evaluateDiscoveryFilters,
  isPostPastMaxAge,
  normalizeDiscoveryFilters,
  postAgeExpiryAt,
  snapshotFromSearchPost,
} from '@/lib/runtime/x/discovery-filters';
import type { XSearchPost } from '@/lib/runtime/x/types';

const now = new Date('2026-11-24T12:00:00.000Z');

function snapshot(overrides: Partial<DiscoveryPostSnapshot> = {}): DiscoveryPostSnapshot {
  return {
    id: '1',
    text: 'Looking for founders building agent tooling',
    createdAt: '2026-11-24T11:30:00.000Z',
    lang: 'en',
    type: 'original',
    hasLinks: false,
    hasMedia: false,
    likes: 3,
    reposts: 1,
    replies: 0,
    quotes: 0,
    impressions: 100,
    authorId: '42',
    authorHandle: 'ops_lead',
    authorName: 'Ops Lead',
    authorBio: 'Building in public',
    authorLocation: 'London',
    authorVerified: true,
    authorFollowers: 1200,
    authorFollowing: 180,
    authorCreatedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function filters(overrides: Partial<DiscoveryFilters> = {}): DiscoveryFilters {
  return { ...defaultDiscoveryFilters(), ...overrides };
}

test('normalizeDiscoveryFilters applies 2h max age and English-only to missing configs', () => {
  expect(normalizeDiscoveryFilters(undefined).maxPostAgeHours).toBe(DEFAULT_MAX_POST_AGE_HOURS);
  expect(normalizeDiscoveryFilters(undefined).rules).toEqual([DEFAULT_LANGUAGE_RULE]);
  expect(normalizeDiscoveryFilters({}).maxPostAgeHours).toBe(2);
  expect(normalizeDiscoveryFilters({}).rules).toEqual([DEFAULT_LANGUAGE_RULE]);
  expect(normalizeDiscoveryFilters(null).version).toBe(1);
});

test('normalizeDiscoveryFilters preserves an explicit empty rules list', () => {
  expect(normalizeDiscoveryFilters({ rules: [] }).rules).toEqual([]);
});

test('configSchema injects discovery filter defaults for legacy records', () => {
  const parsed = configSchema.parse({
    name: 'John',
    role: 'Sales',
    personality: 'Warm',
    mission: 'Find customers',
    instructions: 'Be helpful',
    engagementCriteria: 'Buying intent',
    xSearchQuery: 'founder SaaS',
    mainModel: 'test/main',
    evaluatorModel: 'test/eval',
  });
  expect(parsed.xDiscoveryFilters.maxPostAgeHours).toBe(2);
  expect(parsed.xDiscoveryFilters.rules).toEqual([DEFAULT_LANGUAGE_RULE]);
  expect(parsed.xDiscoveryFilters.skipRecentlyEngagedAuthors).toBe(false);
});

test('discoverySettings exposes normalized filters for old JSON', () => {
  const settings = discoverySettings({ name: 'Legacy', xSearchQuery: 'orbit' });
  expect(settings.filters.maxPostAgeHours).toBe(2);
  expect(settings.filters.rules).toEqual([DEFAULT_LANGUAGE_RULE]);
  expect(settings.queries).toEqual(['orbit']);
});

test('evaluateDiscoveryFilters rejects posts older than maxPostAgeHours', () => {
  const old = snapshot({ createdAt: '2026-11-24T08:00:00.000Z' });
  const decision = evaluateDiscoveryFilters(old, filters({ maxPostAgeHours: 2 }), now);
  expect(decision.pass).toBe(false);
  expect(decision.reasons[0]).toMatch(/max age/i);
});

test('evaluateDiscoveryFilters keeps posts within the age window', () => {
  const fresh = snapshot({ createdAt: '2026-11-24T11:30:00.000Z' });
  const decision = evaluateDiscoveryFilters(fresh, filters({ maxPostAgeHours: 2, rules: [] }), now);
  expect(decision.pass).toBe(true);
});

test('default English-only rule rejects non-English posts', () => {
  const spanish = snapshot({ lang: 'es' });
  const decision = evaluateDiscoveryFilters(spanish, defaultDiscoveryFilters(), now);
  expect(decision.pass).toBe(false);
  expect(decision.reasons.some((reason) => /Language/i.test(reason))).toBe(true);

  const english = snapshot({ lang: 'en' });
  expect(evaluateDiscoveryFilters(english, defaultDiscoveryFilters(), now).pass).toBe(true);
});

test('rule engine supports engagement, author, type and keyword rules', () => {
  const pass = evaluateDiscoveryFilters(
    snapshot(),
    filters({
      rules: [
        { field: 'post.lang', op: 'eq', value: 'en' },
        { field: 'post.type', op: 'in', value: ['original', 'quote'] },
        { field: 'post.hasLinks', op: 'is_false' },
        { field: 'post.likes', op: 'gte', value: 1 },
        { field: 'author.followers', op: 'gte', value: 100 },
        { field: 'author.verified', op: 'is_true' },
        { field: 'author.handle', op: 'not_in', value: ['spam_bot'] },
        { field: 'post.text', op: 'matches_any', value: ['founder', 'agent'] },
        { field: 'author.bio', op: 'contains', value: 'Building' },
      ],
    }),
    now,
  );
  expect(pass.pass).toBe(true);

  const fail = evaluateDiscoveryFilters(
    snapshot({ authorHandle: 'spam_bot', likes: 0 }),
    filters({
      rules: [
        { field: 'author.handle', op: 'not_in', value: ['spam_bot'] },
        { field: 'post.likes', op: 'gte', value: 1 },
      ],
    }),
    now,
  );
  expect(fail.pass).toBe(false);
  expect(fail.reasons.length).toBeGreaterThanOrEqual(1);
});

test('skipRecentlyEngagedAuthors fails when the snapshot is marked engaged', () => {
  const decision = evaluateDiscoveryFilters(
    snapshot({ authorRecentlyEngaged: true }),
    filters({
      skipRecentlyEngagedAuthors: true,
      recentlyEngagedWithinHours: 24,
      rules: [],
    }),
    now,
  );
  expect(decision.pass).toBe(false);
  expect(decision.reasons[0]).toMatch(/engaged/i);
});

test('applyDiscoveryFilters preserves order and records skip reasons', () => {
  const posts: XSearchPost[] = [
    {
      id: '10',
      text: 'fresh founder post',
      createdAt: '2026-11-24T11:45:00.000Z',
      lang: 'en',
      authorUsername: 'a',
      raw: { id: '10', created_at: '2026-11-24T11:45:00.000Z', lang: 'en' },
    },
    {
      id: '11',
      text: 'stale founder post',
      createdAt: '2026-11-23T10:00:00.000Z',
      lang: 'en',
      authorUsername: 'b',
      raw: { id: '11', created_at: '2026-11-23T10:00:00.000Z', lang: 'en' },
    },
  ];
  const result = applyDiscoveryFilters(posts, {
    filters: filters({ maxPostAgeHours: 2, rules: [] }),
    now,
  });
  expect(result.kept.map((post) => post.id)).toEqual(['10']);
  expect(result.rejected).toHaveLength(1);
  expect(result.rejected[0]?.skipReason).toMatch(/max age/i);
});

test('isPostPastMaxAge and postAgeExpiryAt drive approve-time staleness', () => {
  expect(isPostPastMaxAge('2026-11-24T08:00:00.000Z', 2, now)).toBe(true);
  expect(isPostPastMaxAge('2026-11-24T11:30:00.000Z', 2, now)).toBe(false);
  expect(isPostPastMaxAge(null, 2, now)).toBe(true);
  expect(postAgeExpiryAt('2026-11-24T10:00:00.000Z', 2)?.toISOString()).toBe(
    '2026-11-24T12:00:00.000Z',
  );
});

test('snapshotFromSearchPost reads metrics and author expansions from raw', () => {
  const snap = snapshotFromSearchPost({
    id: '99',
    text: 'hello https://example.com',
    createdAt: '2026-11-24T11:00:00.000Z',
    raw: {
      id: '99',
      text: 'hello https://example.com',
      created_at: '2026-11-24T11:00:00.000Z',
      lang: 'en',
      public_metrics: { like_count: 5, retweet_count: 2, reply_count: 1, quote_count: 0 },
      referenced_tweets: [{ type: 'quoted' }],
      entities: { urls: [{ url: 'https://example.com' }] },
      attachments: { media_keys: ['m1'] },
      __author: {
        id: '7',
        username: 'maya',
        name: 'Maya',
        verified: true,
        description: 'Connector',
        location: 'NYC',
        created_at: '2019-05-01T00:00:00.000Z',
        public_metrics: { followers_count: 900, following_count: 400 },
      },
    },
  });
  expect(snap.type).toBe('quote');
  expect(snap.hasLinks).toBe(true);
  expect(snap.hasMedia).toBe(true);
  expect(snap.likes).toBe(5);
  expect(snap.authorHandle).toBe('maya');
  expect(snap.authorFollowers).toBe(900);
  expect(snap.authorVerified).toBe(true);
});

test('over-long list phrases are truncated without resetting other saved filters', () => {
  const normalized = normalizeDiscoveryFilters({
    maxPostAgeHours: 6,
    skipRecentlyEngagedAuthors: true,
    rules: [
      { field: 'post.text', op: 'matches_none', value: ['x'.repeat(300), 'spam'] },
      { field: 'post.lang', op: 'eq', value: 'fr' },
    ],
  });
  expect(normalized.maxPostAgeHours).toBe(6);
  expect(normalized.skipRecentlyEngagedAuthors).toBe(true);
  expect(normalized.rules).toHaveLength(2);
  expect((normalized.rules[0]?.value as string[])[0]).toHaveLength(200);
});
