import { expect, test } from 'bun:test';

import { discoverySettings } from '@/lib/runtime/config';

test('discoverySettings reads legacy single-query configuration without new fields', () => {
  expect(discoverySettings({ name: 'Legacy', xSearchQuery: ' from:orbit ' })).toEqual({
    queries: ['from:orbit'],
    paused: false,
    maxPosts: 10,
  });
});

test('discoverySettings prefers the query list and clamps the cap', () => {
  expect(
    discoverySettings({
      xSearchQueries: ['a', ' b '],
      xSearchQuery: 'old',
      xDiscoveryPaused: true,
      xDiscoveryMaxPostsPerPoll: 500,
    }),
  ).toEqual({ queries: ['a', 'b'], paused: true, maxPosts: 50 });
});

test('discoverySettings tolerates empty or malformed records', () => {
  expect(discoverySettings(null)).toEqual({ queries: [], paused: false, maxPosts: 10 });
  expect(discoverySettings({})).toEqual({ queries: [], paused: false, maxPosts: 10 });
});
