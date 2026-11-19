import { expect, test } from 'bun:test';

import { configSchema } from '@/lib/runtime/config';
import {
  compareSnowflake,
  createFixtureXSearchAdapter,
  FIXTURE_X_POSTS,
} from '@/lib/runtime/x/fixture';
import { createLiveXSearchAdapter } from '@/lib/runtime/x/live';
import { formatDiscoveryInput } from '@/lib/runtime/x/poll';
import { optionalXBearerToken } from '@/lib/runtime/x/settings';

test('config schema defaults empty X search query', () => {
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
});

test('optional X bearer token rejects whitespace and accepts unset', () => {
  expect(optionalXBearerToken.parse(undefined)).toBeUndefined();
  expect(optionalXBearerToken.parse('')).toBeUndefined();
  expect(optionalXBearerToken.parse('  token  ')).toBe('token');
  expect(() => optionalXBearerToken.parse('bad token')).toThrow();
});

test('live adapter is unavailable without a bearer token', () => {
  const adapter = createLiveXSearchAdapter(undefined);
  expect(adapter.availability()).toEqual({
    available: false,
    reason: 'X_BEARER_TOKEN is not set. X discovery polling is unavailable.',
  });
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
