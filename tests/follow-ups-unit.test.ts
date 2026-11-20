import { describe, expect, test } from 'bun:test';

import {
  hasTimezoneOffset,
  localDatetimeToOffsetIso,
  parseOffsetBearingDueAt,
} from '@/lib/runtime/follow-ups/due';
import { mergeFollowUpListViews } from '@/lib/runtime/follow-ups/list';
import { followUpWorkspaceRefresh } from '@/lib/runtime/follow-ups/refresh';
import {
  FOLLOW_UP_ACTIVITY_KINDS,
  FOLLOW_UP_JOB_TYPE,
  FOLLOW_UP_LIFECYCLE_POLICY,
  followUpJobPayloadSchema,
  followUpStatusLabels,
  offsetBearingDueAtSchema,
  scheduleFollowUpInputSchema,
  type FollowUpStatus,
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

describe('follow-up list merging', () => {
  function row(id: string, status: FollowUpStatus, dueAt: string, createdAt = dueAt) {
    return { id, status, dueAt: new Date(dueAt), createdAt: new Date(createdAt) };
  }

  test('keeps every scheduled row ahead of capped history', () => {
    const earliest = row('early', 'scheduled', '2026-01-01T00:00:00.000Z');
    const later = row('later', 'scheduled', '2027-01-01T00:00:00.000Z');
    const history = Array.from({ length: 100 }, (_, index) =>
      row(
        `done-${index}`,
        'completed',
        `2028-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      ),
    );

    const merged = mergeFollowUpListViews([later, earliest], history);
    expect(merged[0]?.id).toBe('early');
    expect(merged[1]?.id).toBe('later');
    expect(merged).toHaveLength(102);
    expect(merged.some((item) => item.id === 'early')).toBe(true);
  });

  test('dedupes scheduled rows that also appear in history', () => {
    const scheduled = row('same', 'scheduled', '2026-06-01T00:00:00.000Z');
    const merged = mergeFollowUpListViews(
      [scheduled],
      [
        { ...scheduled, status: 'completed' as const },
        row('other', 'cancelled', '2026-05-01T00:00:00.000Z'),
      ],
    );
    expect(merged.map((item) => item.id)).toEqual(['same', 'other']);
  });
});

describe('follow-up workspace refresh plan', () => {
  test('polls frequently when a follow-up is already due', () => {
    const plan = followUpWorkspaceRefresh({
      now: new Date('2026-06-15T12:00:00.000Z'),
      scheduled: [{ dueAt: new Date('2026-06-15T11:00:00.000Z'), jobStatus: 'pending' }],
    });
    expect(plan).toEqual({ pollFrequently: true, refreshAt: null });
  });

  test('polls frequently while the follow-up job is claimed', () => {
    const plan = followUpWorkspaceRefresh({
      now: new Date('2026-06-15T12:00:00.000Z'),
      scheduled: [{ dueAt: new Date('2026-06-20T12:00:00.000Z'), jobStatus: 'claimed' }],
    });
    expect(plan.pollFrequently).toBe(true);
  });

  test('schedules a single refresh for the next future due time', () => {
    const next = new Date('2026-06-20T15:30:00.000Z');
    const plan = followUpWorkspaceRefresh({
      now: new Date('2026-06-15T12:00:00.000Z'),
      scheduled: [
        { dueAt: new Date('2026-07-01T00:00:00.000Z'), jobStatus: 'pending' },
        { dueAt: next, jobStatus: 'pending' },
      ],
    });
    expect(plan.pollFrequently).toBe(false);
    expect(plan.refreshAt?.toISOString()).toBe(next.toISOString());
  });

  test('is idle when nothing is scheduled', () => {
    expect(followUpWorkspaceRefresh({ now: new Date(), scheduled: [] })).toEqual({
      pollFrequently: false,
      refreshAt: null,
    });
  });
});
