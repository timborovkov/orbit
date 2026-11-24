import { expect, test } from 'bun:test';

import {
  filterHistoryRuns,
  formatHistoryDayHeading,
  groupHistoryByDay,
  historyDayKey,
  matchesHistoryFilters,
} from '@/lib/runtime/history-filters';

const runs = [
  {
    id: 'a',
    origin: 'playground',
    displayStatus: 'completed',
    configurationId: 'cfg-1',
    createdAt: '2026-11-24T10:00:00.000Z',
    sourceTitle: 'Hello',
  },
  {
    id: 'b',
    origin: 'discovery',
    displayStatus: 'awaiting_approval',
    configurationId: 'cfg-2',
    createdAt: '2026-11-24T12:00:00.000Z',
    sourceTitle: 'X post',
  },
  {
    id: 'c',
    origin: 'discovery',
    displayStatus: 'completed',
    configurationId: 'cfg-1',
    createdAt: '2026-11-23T09:00:00.000Z',
    sourceTitle: 'Older',
  },
];

test('matchesHistoryFilters supports status, source, and configuration', () => {
  expect(
    matchesHistoryFilters(runs[0]!, {
      status: 'completed',
      source: 'playground',
      configurationId: 'cfg-1',
    }),
  ).toBe(true);
  expect(
    matchesHistoryFilters(runs[1]!, {
      status: 'completed',
      source: 'all',
      configurationId: 'all',
    }),
  ).toBe(false);
});

test('filterHistoryRuns and groupHistoryByDay keep newest-first day buckets', () => {
  const filtered = filterHistoryRuns(runs, {
    status: 'all',
    source: 'discovery',
    configurationId: 'all',
  });
  expect(filtered.map((run) => run.id)).toEqual(['b', 'c']);
  const groups = groupHistoryByDay(filtered);
  expect(groups.map((group) => group.dayKey)).toEqual(['2026-11-24', '2026-11-23']);
  expect(historyDayKey(runs[0]!.createdAt)).toBe('2026-11-24');
  expect(formatHistoryDayHeading('2026-11-24')).toContain('Nov');
});
