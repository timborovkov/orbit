/**
 * Decide how the agent workspace should refresh while follow-ups are scheduled.
 * Check reply waits periodically. A time-only reminder needs one refresh at its
 * deadline, then frequent updates while the worker handles it.
 */
export function followUpWorkspaceRefresh(input: {
  now: Date;
  scheduled: { dueAt: Date; jobStatus: string | null; waitForReply?: boolean }[];
}): { pollFrequently: boolean; refreshAt: Date | null; intervalMs?: number } {
  if (!input.scheduled.length) return { pollFrequently: false, refreshAt: null };

  const nowMs = input.now.getTime();
  const dueOrExecuting = input.scheduled.some(
    (row) => row.dueAt.getTime() <= nowMs || row.jobStatus === 'claimed',
  );
  if (dueOrExecuting) return { pollFrequently: true, refreshAt: null };
  if (input.scheduled.some((row) => row.waitForReply)) {
    return { pollFrequently: true, refreshAt: null, intervalMs: 10_000 };
  }

  const nextDueMs = input.scheduled
    .map((row) => row.dueAt.getTime())
    .filter((due) => due > nowMs)
    .sort((a, b) => a - b)
    .at(0);
  if (nextDueMs === undefined) return { pollFrequently: false, refreshAt: null };
  return { pollFrequently: false, refreshAt: new Date(nextDueMs) };
}
