import { describe, expect, test } from 'bun:test';

import {
  hasTimezoneOffset,
  localDatetimeToOffsetIso,
  parseOffsetBearingDueAt,
} from '@/lib/runtime/follow-ups/due';
import {
  FOLLOW_UP_ACTIVITY_KINDS,
  FOLLOW_UP_JOB_TYPE,
  FOLLOW_UP_LIFECYCLE_POLICY,
  followUpJobPayloadSchema,
  followUpStatusLabels,
  offsetBearingDueAtSchema,
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

describe('follow-up due time timezone conversion', () => {
  test('local datetime-local values convert to offset-bearing ISO', () => {
    const iso = localDatetimeToOffsetIso('2026-06-15T14:30');
    expect(iso).toBeTruthy();
    expect(hasTimezoneOffset(iso!)).toBe(true);
    expect(iso).toMatch(/Z$/i);

    const roundTrip = new Date(iso!);
    expect(roundTrip.getFullYear()).toBe(2026);
    expect(roundTrip.getMonth()).toBe(5);
    expect(roundTrip.getDate()).toBe(15);
    expect(roundTrip.getHours()).toBe(14);
    expect(roundTrip.getMinutes()).toBe(30);
  });

  test('local conversion rejects invalid calendar dates', () => {
    expect(localDatetimeToOffsetIso('2026-02-30T10:00')).toBeNull();
    expect(localDatetimeToOffsetIso('not-a-date')).toBeNull();
  });

  test('server parsing rejects bare datetime-local without an offset', () => {
    expect(hasTimezoneOffset('2026-06-15T14:30')).toBe(false);
    expect(parseOffsetBearingDueAt('2026-06-15T14:30')).toBeNull();
    expect(offsetBearingDueAtSchema.safeParse('2026-06-15T14:30').success).toBe(false);
  });

  test('server parsing accepts Z and numeric offsets', () => {
    const zulu = offsetBearingDueAtSchema.safeParse('2026-06-15T14:30:00.000Z');
    expect(zulu.success).toBe(true);
    if (zulu.success) expect(zulu.data.toISOString()).toBe('2026-06-15T14:30:00.000Z');

    const offset = offsetBearingDueAtSchema.safeParse('2026-06-15T14:30:00+02:00');
    expect(offset.success).toBe(true);
    if (offset.success) expect(offset.data.toISOString()).toBe('2026-06-15T12:30:00.000Z');
  });

  test('converted local values are accepted by the server schema', () => {
    const iso = localDatetimeToOffsetIso('2026-11-20T09:15');
    expect(iso).toBeTruthy();
    const parsed = offsetBearingDueAtSchema.safeParse(iso!);
    expect(parsed.success).toBe(true);
  });
});
