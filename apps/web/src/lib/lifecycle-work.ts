import { and, eq, inArray } from 'drizzle-orm';

import { db, type Db, type Tx } from '@/lib/db';
import { cancelPendingJobsForAgent } from '@/lib/queue/jobs';
import { runs } from '@/lib/schema';

type Store = Db | Tx;

/**
 * Cancel jobs for a pause/stop transition and interrupt linked non-terminal runs.
 * Pause keeps claimed work running; stop cancels claims and interrupts all active runs.
 */
export async function cancelWorkForLifecycle(
  agentId: string,
  next: 'paused' | 'stopped',
  store: Store = db(),
): Promise<string[]> {
  const includeClaimed = next === 'stopped';
  const cancelledIds = await cancelPendingJobsForAgent(agentId, store, { includeClaimed });
  if (next === 'stopped') {
    await store
      .update(runs)
      .set({
        status: 'interrupted',
        finishedAt: new Date(),
        deferReason: 'Agent stopped; pending work cancelled.',
      })
      .where(and(eq(runs.agentId, agentId), inArray(runs.status, ['queued', 'running'])));
  } else if (cancelledIds.length) {
    // Interrupt queued runs and retry-waiting running runs whose pending jobs were cancelled.
    // Preserve genuinely active claimed executions (pause does not cancel claimed jobs).
    await store
      .update(runs)
      .set({
        status: 'interrupted',
        finishedAt: new Date(),
        deferReason: 'Agent paused; queued work cancelled.',
      })
      .where(
        and(
          eq(runs.agentId, agentId),
          inArray(runs.status, ['queued', 'running']),
          inArray(runs.jobId, cancelledIds),
        ),
      );
  }
  return cancelledIds;
}
