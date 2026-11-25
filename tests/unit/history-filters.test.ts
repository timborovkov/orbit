import { expect, test } from 'bun:test';

import {
  filterHistoryRuns,
  formatHistoryDayHeading,
  groupHistoryByDay,
  historyDayKey,
  historyPageForRunId,
  matchesHistoryFilters,
  paginateHistoryRuns,
  sortHistoryRunsNewestFirst,
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

/** Intentionally scrambled like SQL focus/crawl boosts can produce. */
const scrambledDays = [
  {
    id: 'old',
    origin: 'discovery',
    displayStatus: 'completed',
    configurationId: 'cfg-1',
    createdAt: '2026-11-23T18:00:00.000Z',
    sourceTitle: 'Monday boost',
  },
  {
    id: 'newest',
    origin: 'discovery',
    displayStatus: 'awaiting_approval',
    configurationId: 'cfg-2',
    createdAt: '2026-11-25T08:00:00.000Z',
    sourceTitle: 'Wednesday',
  },
  {
    id: 'mid-late',
    origin: 'playground',
    displayStatus: 'completed',
    configurationId: 'cfg-1',
    createdAt: '2026-11-24T20:00:00.000Z',
    sourceTitle: 'Tuesday evening',
  },
  {
    id: 'mid-early',
    origin: 'discovery',
    displayStatus: 'failed',
    configurationId: 'cfg-1',
    createdAt: '2026-11-24T09:00:00.000Z',
    sourceTitle: 'Tuesday morning',
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

test('sortHistoryRunsNewestFirst then groupHistoryByDay orders scrambled days newest first', () => {
  const sorted = sortHistoryRunsNewestFirst(scrambledDays);
  expect(sorted.map((run) => run.id)).toEqual(['newest', 'mid-late', 'mid-early', 'old']);

  const groups = groupHistoryByDay(scrambledDays);
  expect(groups.map((group) => group.dayKey)).toEqual(['2026-11-25', '2026-11-24', '2026-11-23']);
  expect(groups[1]!.runs.map((run) => run.id)).toEqual(['mid-late', 'mid-early']);
});

test('paginateHistoryRuns clamps page and slices stably', () => {
  const page1 = paginateHistoryRuns(runs, 1, 2);
  expect(page1.items.map((run) => run.id)).toEqual(['a', 'b']);
  expect(page1.totalPages).toBe(2);
  const page2 = paginateHistoryRuns(runs, 99, 2);
  expect(page2.page).toBe(2);
  expect(page2.items.map((run) => run.id)).toEqual(['c']);
});

test('historyPageForRunId selects the page that contains a focused run', () => {
  expect(historyPageForRunId(runs, undefined, 2)).toBeNull();
  expect(historyPageForRunId(runs, 'a', 2)).toBe(1);
  expect(historyPageForRunId(runs, 'c', 2)).toBe(2);
  expect(historyPageForRunId(runs, 'missing', 2)).toBe(1);
});
