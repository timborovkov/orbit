import type { FollowUpStatus } from '@/lib/runtime/follow-ups/types';

/** Rows used when merging scheduled commitments with capped history. */
export interface FollowUpListItem {
  id: string;
  status: FollowUpStatus;
  dueAt: Date;
  createdAt: Date;
}

/**
 * Always keep every scheduled follow-up, then append capped history.
 * Scheduled rows come first (soonest due first) so active commitments stay
 * reachable even when history would otherwise fill a fixed limit.
 */
export function mergeFollowUpListViews<T extends FollowUpListItem>(
  scheduled: T[],
  history: T[],
): T[] {
  const scheduledIds = new Set(scheduled.map((row) => row.id));
  const scheduledOrdered = [...scheduled].sort((a, b) => {
    const byDue = a.dueAt.getTime() - b.dueAt.getTime();
    if (byDue !== 0) return byDue;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  const historyOrdered = history.filter((row) => !scheduledIds.has(row.id));
  return [...scheduledOrdered, ...historyOrdered];
}
