/**
 * Decide how the agent workspace should refresh while follow-ups are scheduled.
 * Due or in-flight work polls frequently; future dues schedule one refresh at
 * the next due instant so idle days do not hammer router.refresh().
 */
export function followUpWorkspaceRefresh(input: {
  now: Date;
  scheduled: { dueAt: Date; jobStatus: string | null }[];
}): { pollFrequently: boolean; refreshAt: Date | null } {
  if (!input.scheduled.length) return { pollFrequently: false, refreshAt: null };

  const nowMs = input.now.getTime();
  const dueOrExecuting = input.scheduled.some(
    (row) => row.dueAt.getTime() <= nowMs || row.jobStatus === 'claimed',
  );
  if (dueOrExecuting) return { pollFrequently: true, refreshAt: null };

  const nextDueMs = input.scheduled
    .map((row) => row.dueAt.getTime())
    .filter((due) => due > nowMs)
    .sort((a, b) => a - b)
    .at(0);
  if (nextDueMs === undefined) return { pollFrequently: false, refreshAt: null };
  return { pollFrequently: false, refreshAt: new Date(nextDueMs) };
}
