/** Pure helpers for Agent History filtering and day grouping. */

export type HistoryFilterStatus =
  | 'all'
  | 'completed'
  | 'failed'
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'deferred'
  | 'interrupted';

export type HistoryRunLike = {
  id: string;
  origin: string;
  displayStatus: string;
  configurationId: string;
  createdAt: Date | string;
  sourceTitle: string;
  channelName?: string;
};

export type HistoryFilters = {
  status: HistoryFilterStatus;
  source: string; // 'all' or origin/channel key
  configurationId: string; // 'all' or uuid
};

export const defaultHistoryFilters: HistoryFilters = {
  status: 'all',
  source: 'all',
  configurationId: 'all',
};

function historySourceKey(run: Pick<HistoryRunLike, 'origin' | 'channelName'>): string {
  return run.origin;
}

export function matchesHistoryFilters(run: HistoryRunLike, filters: HistoryFilters): boolean {
  if (filters.status !== 'all' && run.displayStatus !== filters.status) return false;
  if (filters.source !== 'all' && historySourceKey(run) !== filters.source) return false;
  if (filters.configurationId !== 'all' && run.configurationId !== filters.configurationId) {
    return false;
  }
  return true;
}

export function filterHistoryRuns<T extends HistoryRunLike>(
  runs: readonly T[],
  filters: HistoryFilters,
): T[] {
  return runs.filter((run) => matchesHistoryFilters(run, filters));
}

/** UTC calendar day key YYYY-MM-DD. */
export function historyDayKey(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toISOString().slice(0, 10);
}

const historyDayHeading = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatHistoryDayHeading(dayKey: string): string {
  if (dayKey === 'unknown') return 'Unknown date';
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return dayKey;
  return historyDayHeading.format(date);
}

export type HistoryDayGroup<T extends HistoryRunLike> = {
  dayKey: string;
  label: string;
  runs: T[];
};

/** Group newest-first runs into day buckets (also newest-first). */
export function groupHistoryByDay<T extends HistoryRunLike>(
  runs: readonly T[],
): HistoryDayGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const run of runs) {
    const key = historyDayKey(run.createdAt);
    const list = groups.get(key);
    if (list) list.push(run);
    else groups.set(key, [run]);
  }
  return [...groups.entries()].map(([dayKey, dayRuns]) => ({
    dayKey,
    label: formatHistoryDayHeading(dayKey),
    runs: dayRuns,
  }));
}

export function uniqueHistorySources(runs: readonly HistoryRunLike[]): string[] {
  return [...new Set(runs.map(historySourceKey))].sort();
}
