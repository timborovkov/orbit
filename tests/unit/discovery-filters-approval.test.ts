import { expect, test } from 'bun:test';

import {
  evaluateDiscoveryFilters,
  isPostPastMaxAge,
  normalizeDiscoveryFilters,
} from '@/lib/runtime/x/discovery-filters';
import {
  DISCOVERY_STALE_APPROVAL_REASON,
  discoveryReviewExpiresAt,
} from '@/lib/runtime/x/discovery-filters/server';

const now = new Date('2026-11-24T14:00:00.000Z');

test('approve-time staleness refuses posts past maxPostAge', () => {
  const filters = normalizeDiscoveryFilters({ maxPostAgeHours: 2 });
  expect(isPostPastMaxAge('2026-11-24T11:00:00.000Z', filters.maxPostAgeHours, now)).toBe(true);
  expect(DISCOVERY_STALE_APPROVAL_REASON).toMatch(/max post age/i);
});

test('discoveryReviewExpiresAt picks the earlier of approval and post-age expiry', () => {
  const postCreated = '2026-11-24T12:00:00.000Z';
  const approvalExpiry = new Date('2026-11-25T12:00:00.000Z');
  const combined = discoveryReviewExpiresAt(postCreated, 2, approvalExpiry);
  expect(combined?.toISOString()).toBe('2026-11-24T14:00:00.000Z');

  const earlierApproval = new Date('2026-11-24T13:00:00.000Z');
  expect(discoveryReviewExpiresAt(postCreated, 2, earlierApproval)?.toISOString()).toBe(
    '2026-11-24T13:00:00.000Z',
  );
});

test('expiry candidate detection mirrors filter max age', () => {
  const filters = normalizeDiscoveryFilters({ maxPostAgeHours: 1 });
  const staleAt = new Date('2026-11-24T15:30:00.000Z');
  expect(isPostPastMaxAge('2026-11-24T14:00:00.000Z', filters.maxPostAgeHours, staleAt)).toBe(true);
  expect(isPostPastMaxAge('2026-11-24T14:45:00.000Z', filters.maxPostAgeHours, staleAt)).toBe(
    false,
  );
});

test('re-check at approval still applies non-age rules', () => {
  const decision = evaluateDiscoveryFilters(
    {
      id: '1',
      text: 'hello',
      createdAt: '2026-11-24T13:30:00.000Z',
      lang: 'es',
      type: 'original',
      hasLinks: false,
      hasMedia: false,
      likes: 0,
      reposts: 0,
      replies: 0,
      quotes: 0,
      impressions: null,
      authorId: '1',
      authorHandle: 'a',
      authorName: 'A',
      authorBio: null,
      authorLocation: null,
      authorVerified: false,
      authorFollowers: 10,
      authorFollowing: 10,
      authorCreatedAt: null,
    },
    // Defaults already include English-only; explicit rule keeps the same gate.
    normalizeDiscoveryFilters({
      maxPostAgeHours: 2,
    }),
    now,
  );
  expect(decision.pass).toBe(false);
  expect(decision.reasons.some((reason) => /Language/i.test(reason))).toBe(true);
});
