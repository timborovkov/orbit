import { expect, test } from 'bun:test';

import {
  clampDiscoveryMaxPosts,
  discoveryCostHint,
  estimateDiscoverySearchRequests,
} from '@/lib/runtime/x/discovery-cost';

test('clampDiscoveryMaxPosts bounds the per-poll cap', () => {
  expect(clampDiscoveryMaxPosts(undefined)).toBe(10);
  expect(clampDiscoveryMaxPosts(0)).toBe(1);
  expect(clampDiscoveryMaxPosts(3.9)).toBe(3);
  expect(clampDiscoveryMaxPosts(999)).toBe(50);
});

test('estimateDiscoverySearchRequests is one page per query', () => {
  expect(estimateDiscoverySearchRequests({ queryCount: 0 })).toBe(0);
  expect(estimateDiscoverySearchRequests({ queryCount: 1 })).toBe(1);
  expect(estimateDiscoverySearchRequests({ queryCount: 3 })).toBe(3);
});

test('discoveryCostHint describes pause and live polling', () => {
  expect(discoveryCostHint({ queryCount: 1, maxPostsPerPoll: 10, paused: true })).toContain(
    'Polling is paused',
  );
  expect(discoveryCostHint({ queryCount: 2, maxPostsPerPoll: 10, paused: false })).toContain(
    '2 queries',
  );
});
