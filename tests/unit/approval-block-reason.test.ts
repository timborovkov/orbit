import { expect, test } from 'bun:test';

import { approvalBlockReason, clarifyApprovalError } from '@/lib/approvals/block-reason';

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

test('clarifyApprovalError expands short gateway strings', () => {
  expect(clarifyApprovalError('Agent is paused.')).toContain('Resume it');
  expect(clarifyApprovalError('Global outbound pause is enabled.')).toContain('Release it');
  expect(clarifyApprovalError('Something else')).toBe('Something else');
});
