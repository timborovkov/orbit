import { expect, test } from 'bun:test';

import {
  notifyApprovalPending,
  resetApprovalNotifier,
  setApprovalNotifier,
} from '@/lib/approvals/notify';

test('approval notifier hook can be replaced and reset', async () => {
  const seen: string[] = [];
  setApprovalNotifier((event) => {
    seen.push(event.intentId);
  });
  await notifyApprovalPending({
    intentId: '00000000-0000-4000-8000-000000000001',
    agentId: '00000000-0000-4000-8000-000000000002',
    runId: null,
    actionType: 'reply',
    reason: 'test',
    createdAt: new Date(),
  });
  expect(seen).toEqual(['00000000-0000-4000-8000-000000000001']);
  resetApprovalNotifier();
  await notifyApprovalPending({
    intentId: '00000000-0000-4000-8000-000000000003',
    agentId: '00000000-0000-4000-8000-000000000002',
    runId: null,
    actionType: 'reply',
    reason: 'ignored',
    createdAt: new Date(),
  });
  expect(seen).toHaveLength(1);
});
