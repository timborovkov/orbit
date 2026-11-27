import { expect, test } from 'bun:test';

import { approvalBlockReason, clarifyApprovalError } from '@/lib/approvals/block-reason';
import { INTRODUCTION_REVIEW } from '@/lib/runtime/introductions/types';
import { X_REPLY_ACTION } from '@/lib/runtime/x/reply-input';

test('approvalBlockReason covers paused, stopped, and global pause', () => {
  expect(approvalBlockReason({ lifecycle: 'paused', globalPaused: false })).toContain(
    'Agent is paused',
  );
  expect(approvalBlockReason({ lifecycle: 'stopped', globalPaused: false })).toContain(
    'Agent is stopped',
  );
  expect(approvalBlockReason({ lifecycle: 'live', globalPaused: true })).toContain(
    'Global outbound pause',
  );
  expect(approvalBlockReason({ lifecycle: 'shadow', globalPaused: false })).toBeNull();
});

test('approvalBlockReason exempts introduction reviews from pause and lifecycle blocks', () => {
  expect(
    approvalBlockReason({
      lifecycle: 'paused',
      globalPaused: true,
      actionType: INTRODUCTION_REVIEW,
    }),
  ).toBeNull();
  expect(
    approvalBlockReason({
      lifecycle: 'stopped',
      globalPaused: false,
      actionType: INTRODUCTION_REVIEW,
    }),
  ).toBeNull();
  expect(
    approvalBlockReason({
      lifecycle: 'paused',
      globalPaused: false,
      actionType: X_REPLY_ACTION,
    }),
  ).toContain('Agent is paused');
});

test('clarifyApprovalError expands short gateway strings', () => {
  expect(clarifyApprovalError('Agent is paused.')).toContain('Resume it');
  expect(clarifyApprovalError('Global outbound pause is enabled.')).toContain('Release it');
  expect(clarifyApprovalError('Something else')).toBe('Something else');
});
