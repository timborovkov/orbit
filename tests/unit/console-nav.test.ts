import { expect, test } from 'bun:test';

import {
  currentConsoleNavFromPath,
  PENDING_APPROVAL_COUNT_POLL_MS,
  resolvedPendingApprovalCount,
} from '@/lib/runtime/console-nav';

test('currentConsoleNavFromPath matches console sections and nested routes', () => {
  expect(currentConsoleNavFromPath('/')).toBe('/');
  expect(currentConsoleNavFromPath('/approvals')).toBe('/approvals');
  expect(currentConsoleNavFromPath('/people/abc')).toBe('/people');
  expect(currentConsoleNavFromPath('/knowledge/lib-1')).toBe('/knowledge');
  expect(currentConsoleNavFromPath('/agents/abc')).toBeUndefined();
  expect(currentConsoleNavFromPath('/login')).toBeUndefined();
});

test('resolvedPendingApprovalCount prefers a live fetch for the current server seed', () => {
  expect(resolvedPendingApprovalCount(3, null, null)).toBe(3);
  expect(resolvedPendingApprovalCount(3, 5, 3)).toBe(5);
  // Soft refresh supplied a newer seed; discard the stale live value until the next fetch.
  expect(resolvedPendingApprovalCount(1, 5, 3)).toBe(1);
});

test('pending approval poll interval stays a light background refresh', () => {
  expect(PENDING_APPROVAL_COUNT_POLL_MS).toBeGreaterThanOrEqual(10_000);
  expect(PENDING_APPROVAL_COUNT_POLL_MS).toBeLessThanOrEqual(60_000);
});
