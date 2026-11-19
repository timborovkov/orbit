import { describe, expect, test } from 'bun:test';

import {
  FOLLOW_UP_ACTIVITY_KINDS,
  FOLLOW_UP_JOB_TYPE,
  FOLLOW_UP_LIFECYCLE_POLICY,
  followUpJobPayloadSchema,
  followUpStatusLabels,
  scheduleFollowUpInputSchema,
} from '@/lib/runtime/follow-ups/types';

describe('follow-up schemas and constants', () => {
  test('job type and activity kinds are stable', () => {
    expect(FOLLOW_UP_JOB_TYPE).toBe('followup.execute');
    expect(FOLLOW_UP_ACTIVITY_KINDS.completed).toBe('follow_up.completed');
    expect(FOLLOW_UP_ACTIVITY_KINDS.skipped).toBe('follow_up.skipped');
    expect(followUpStatusLabels.scheduled).toBe('Scheduled');
  });

  test('lifecycle policy is skip-and-record', () => {
    expect(FOLLOW_UP_LIFECYCLE_POLICY.toLowerCase()).toContain('skip-and-record');
    expect(FOLLOW_UP_LIFECYCLE_POLICY).toContain('paused');
    expect(FOLLOW_UP_LIFECYCLE_POLICY).toContain('stopped');
  });

  test('schedule input rejects empty subjects', () => {
    expect(
      scheduleFollowUpInputSchema.safeParse({
        agentId: '00000000-0000-4000-8000-000000000001',
        subject: '   ',
        dueAt: new Date(),
      }).success,
    ).toBe(false);
  });

  test('job payload requires followUpId and agentId', () => {
    expect(followUpJobPayloadSchema.safeParse({}).success).toBe(false);
    expect(
      followUpJobPayloadSchema.safeParse({
        followUpId: '00000000-0000-4000-8000-000000000001',
        agentId: '00000000-0000-4000-8000-000000000002',
      }).success,
    ).toBe(true);
  });
});
