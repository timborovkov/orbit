import { expect, test } from 'bun:test';

import { discoverySettings } from '@/lib/runtime/config';
import {
  DEFAULT_LANGUAGE_RULE,
  DEFAULT_MAX_POST_AGE_HOURS,
} from '@/lib/runtime/x/discovery-filters';

test('discoverySettings reads legacy single-query configuration without new fields', () => {
  expect(discoverySettings({ name: 'Legacy', xSearchQuery: ' from:orbit ' })).toEqual({
    queries: ['from:orbit'],
    paused: false,
    maxPosts: 10,
    filters: {
      version: 1,
      maxPostAgeHours: DEFAULT_MAX_POST_AGE_HOURS,
      skipRecentlyEngagedAuthors: false,
      recentlyEngagedWithinHours: 24,
      rules: [DEFAULT_LANGUAGE_RULE],
    },
  });
});

test('discoverySettings prefers the query list and clamps the cap', () => {
  expect(
    discoverySettings({
      xSearchQueries: ['a', ' b '],
      xSearchQuery: 'old',
      xDiscoveryPaused: true,
      xDiscoveryMaxPostsPerPoll: 500,
      xDiscoveryFilters: { maxPostAgeHours: 1.5, rules: [] },
    }),
  ).toEqual({
    queries: ['a', 'b'],
    paused: true,
    maxPosts: 50,
    filters: {
      version: 1,
      maxPostAgeHours: 1.5,
      skipRecentlyEngagedAuthors: false,
      recentlyEngagedWithinHours: 24,
      rules: [],
    },
  });
});

test('discoverySettings tolerates empty or malformed records', () => {
  expect(discoverySettings(null).filters.maxPostAgeHours).toBe(2);
  expect(discoverySettings(null).filters.rules).toEqual([DEFAULT_LANGUAGE_RULE]);
  expect(discoverySettings({}).filters.maxPostAgeHours).toBe(2);
  expect(discoverySettings({}).filters.rules).toEqual([DEFAULT_LANGUAGE_RULE]);
  expect(discoverySettings(null).queries).toEqual([]);
});
