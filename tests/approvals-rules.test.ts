import { expect, test } from 'bun:test';

import { actionNeedsApproval, mergeApprovalTools } from '@/lib/approvals/rules';

test('mergeApprovalTools de-duplicates agent and global lists', () => {
  expect(mergeApprovalTools(['reply', 'like'], ['like', 'follow'])).toEqual([
    'reply',
    'like',
    'follow',
  ]);
});

test('actionNeedsApproval is a no-op for ordinary tools when disabled', () => {
  expect(
    actionNeedsApproval({
      actionType: 'reply',
      approvalTools: [],
      approvalSpendCents: null,
      daySpendMicros: BigInt(0),
    }),
  ).toBe(false);
});

test('actionNeedsApproval honours tool lists and spend gates', () => {
  expect(
    actionNeedsApproval({
      actionType: 'reply',
      approvalTools: ['reply'],
      approvalSpendCents: null,
      daySpendMicros: BigInt(0),
    }),
  ).toBe(true);
  expect(
    actionNeedsApproval({
      actionType: 'reply',
      approvalTools: [],
      approvalSpendCents: 5,
      daySpendMicros: BigInt(4 * 10_000),
    }),
  ).toBe(false);
  expect(
    actionNeedsApproval({
      actionType: 'reply',
      approvalTools: [],
      approvalSpendCents: 5,
      daySpendMicros: BigInt(5 * 10_000),
    }),
  ).toBe(true);
});
