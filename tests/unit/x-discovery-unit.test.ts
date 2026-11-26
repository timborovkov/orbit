import { expect, test } from 'bun:test';

import { configSchema } from '@/lib/runtime/config';
import {
  compareSnowflake,
  createFixtureXSearchAdapter,
  FIXTURE_X_POSTS,
} from '@/lib/runtime/x/fixture';
import { createLiveXSearchAdapter, X_RECENT_SEARCH_MAX_PAGES } from '@/lib/runtime/x/live';
import { formatDiscoveryInput } from '@/lib/runtime/x/poll';
import { optionalXBearerToken } from '@/lib/runtime/x/settings';

test('config schema defaults empty X search queries and discovery controls', () => {
  const parsed = configSchema.parse({
    name: 'John',
    role: 'Sales',
    personality: 'Warm',
    mission: 'Find customers',
    instructions: 'Be helpful',
    engagementCriteria: 'Buying intent',
    mainModel: 'test/main',
    evaluatorModel: 'test/eval',
  });
  expect(parsed.xSearchQuery).toBe('');
  expect(parsed.xSearchQueries).toEqual([]);
  expect(parsed.xDiscoveryPaused).toBe(false);
  expect(parsed.xDiscoveryMaxPostsPerPoll).toBe(10);
  expect(parsed.xDiscoveryFilters.maxPostAgeHours).toBe(2);
  expect(parsed.xDiscoveryFilters.rules).toEqual([{ field: 'post.lang', op: 'eq', value: 'en' }]);
});

test('config schema maps legacy xSearchQuery into xSearchQueries', () => {
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
  expect(parsed.xSearchQueries).toEqual(['founder SaaS']);
  expect(parsed.xSearchQuery).toBe('founder SaaS');
});

test('optional X bearer token rejects whitespace and accepts unset', () => {
  expect(optionalXBearerToken.parse(undefined)).toBeUndefined();
  expect(optionalXBearerToken.parse('')).toBeUndefined();
  expect(optionalXBearerToken.parse('  token  ')).toBe('token');
  expect(() => optionalXBearerToken.parse('bad token')).toThrow();
});

test('live adapter is unavailable without a bearer token', () => {
  const adapter = createLiveXSearchAdapter('');
  expect(adapter.availability()).toEqual({
    available: false,
    reason: 'X_BEARER_TOKEN is not set. X discovery polling is unavailable.',
  });
});

test('live adapter walks next_token pages before returning newest_id', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.searchParams.get('pagination_token') ?? '');
    expect(url.searchParams.get('tweet.fields')).toContain('public_metrics');
    expect(url.searchParams.get('user.fields')).toContain('verified');
    if (!url.searchParams.get('pagination_token')) {
      return Response.json({
        data: [
          {
            id: '2001',
            text: 'page one older',
            author_id: 'u1',
            created_at: '2026-11-18T10:00:00.000Z',
          },
          {
            id: '2002',
            text: 'page one newer',
            author_id: 'u1',
            created_at: '2026-11-18T10:01:00.000Z',
          },
        ],
        includes: { users: [{ id: 'u1', username: 'pager' }] },
        meta: { newest_id: '2002', next_token: 'page-2', result_count: 2 },
      });
    }
    expect(url.searchParams.get('pagination_token')).toBe('page-2');
    expect(url.searchParams.get('since_id')).toBe('1000');
    return Response.json({
      data: [
        {
          id: '2003',
          text: 'page two newest',
          author_id: 'u1',
          created_at: '2026-11-18T10:02:00.000Z',
        },
      ],
      includes: { users: [{ id: 'u1', username: 'pager' }] },
      meta: { newest_id: '2003', result_count: 1 },
    });
  }) as unknown as typeof fetch;

  const adapter = createLiveXSearchAdapter('test-bearer', fetchImpl);
  const result = await adapter.searchRecent({ query: 'orbit', sinceId: '1000' });
  expect(calls).toEqual(['', 'page-2']);
  expect(result.posts.map((post) => post.id)).toEqual(['2001', '2002', '2003']);
  expect(result.newestId).toBe('2003');
});

test('live adapter stops at max pages and still reports the highest newest_id', async () => {
  let pages = 0;
  const fetchImpl = (async () => {
    pages += 1;
    const id = String(3000 + pages);
    return Response.json({
      data: [
        { id, text: `page ${pages}`, author_id: 'u2', created_at: '2026-11-18T11:00:00.000Z' },
      ],
      meta: {
        newest_id: id,
        next_token: pages < 10 ? `tok-${pages}` : undefined,
        result_count: 1,
      },
    });
  }) as unknown as typeof fetch;

  const adapter = createLiveXSearchAdapter('test-bearer', fetchImpl);
  const result = await adapter.searchRecent({ query: 'orbit' });
  expect(pages).toBe(X_RECENT_SEARCH_MAX_PAGES);
  expect(result.posts).toHaveLength(X_RECENT_SEARCH_MAX_PAGES);
  expect(result.newestId).toBe(String(3000 + X_RECENT_SEARCH_MAX_PAGES));
});

test('live adapter honors maxPages and maxPosts so the request bound matches the cost hint', async () => {
  const makeFetch = (counter: { pages: number }) =>
    (async () => {
      counter.pages += 1;
      const id = String(4000 + counter.pages);
      return Response.json({
        data: [
          {
            id,
            text: `page ${counter.pages}`,
            author_id: 'u3',
            created_at: '2026-11-18T12:00:00.000Z',
          },
        ],
        meta: { newest_id: id, next_token: `tok-${counter.pages}`, result_count: 1 },
      });
    }) as unknown as typeof fetch;

  const single = { pages: 0 };
  await createLiveXSearchAdapter('test-bearer', makeFetch(single)).searchRecent({
    query: 'orbit',
    maxPosts: 10,
    maxPages: 1,
  });
  expect(single.pages).toBe(1);

  const capped = { pages: 0 };
  const result = await createLiveXSearchAdapter('test-bearer', makeFetch(capped)).searchRecent({
    query: 'orbit',
    maxPosts: 2,
  });
  expect(capped.pages).toBe(2);
  expect(result.posts).toHaveLength(2);
});

test('fixture adapter returns posts after since_id and supports restart cursors', async () => {
  const adapter = createFixtureXSearchAdapter();
  const first = await adapter.searchRecent({ query: 'work-history' });
  expect(first.posts.map((post) => post.id)).toEqual(['1001']);
  expect(first.newestId).toBe('1001');

  const second = await adapter.searchRecent({ query: 'audit', sinceId: '1001' });
  expect(second.posts.map((post) => post.id)).toEqual(['1002']);
  expect(second.newestId).toBe('1002');

  const third = await adapter.searchRecent({ query: 'audit', sinceId: '1002' });
  expect(third.posts).toEqual([]);
  expect(third.newestId).toBe('1002');
});

test('fixture adapter keeps agents independent by query', async () => {
  const adapter = createFixtureXSearchAdapter();
  const john = await adapter.searchRecent({ query: 'work-history' });
  const sarah = await adapter.searchRecent({ query: 'lunch' });
  expect(john.posts.map((post) => post.id)).toEqual(['1001']);
  expect(sarah.posts.map((post) => post.id)).toEqual(['1003']);
});

test('snowflake compare and discovery input formatting', () => {
  expect(compareSnowflake('1001', '1002')).toBeLessThan(0);
  expect(compareSnowflake('1002', '1002')).toBe(0);
  expect(formatDiscoveryInput(FIXTURE_X_POSTS[0]!)).toContain('@ops_lead');
  expect(formatDiscoveryInput(FIXTURE_X_POSTS[0]!)).toContain('1001');
});
