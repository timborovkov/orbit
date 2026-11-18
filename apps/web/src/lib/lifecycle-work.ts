import { and, eq, inArray } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import { cancelPendingJobsForAgent } from '@/lib/queue/jobs';
import { lockApprovalAgent, recordApprovalReviews } from '@/lib/runtime/approval-work';
import { actionIntents, agents, runs } from '@/lib/schema';

/**
 * Cancel jobs for a pause/stop transition and interrupt linked non-terminal runs.
 * Pause keeps claimed work running; stop cancels claims and interrupts all active runs.
 */
export async function cancelWorkForLifecycle(
  agentId: string,
  next: 'paused' | 'stopped',
  store?: Tx,
): Promise<string[]> {
  if (!store) {
    return db().transaction(async (tx) => {
      await lockApprovalAgent(tx, agentId);
      return cancelWorkForLifecycle(agentId, next, tx);
    });
  }
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
      .where(
        and(
          eq(runs.agentId, agentId),
          inArray(runs.status, ['queued', 'running', 'awaiting_approval']),
        ),
      );
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
  if (next === 'stopped') {
    const agent = (
      await store.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId))
    ).at(0);
    const pending = await store
      .select()
      .from(actionIntents)
      .where(and(eq(actionIntents.agentId, agentId), eq(actionIntents.reviewStatus, 'pending')));
    if (agent)
      await recordApprovalReviews(store, pending, {
        actor: 'system:lifecycle-stop',
        agentName: agent.name,
        status: 'rejected',
        reason: 'Agent stopped; pending approval cancelled.',
        now: new Date(),
      });
  }
  return cancelledIds;
}
