import 'server-only';

import { desc, eq } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { agentActivityEvents, followUps, jobs } from '@/lib/schema';

export async function listFollowUpsForAgent(agentId: string) {
  await requireAdmin();
  const rows = await db()
    .select({
      id: followUps.id,
      agentId: followUps.agentId,
      source: followUps.source,
      createdBy: followUps.createdBy,
      subject: followUps.subject,
      note: followUps.note,
      dueAt: followUps.dueAt,
      status: followUps.status,
      attempts: followUps.attempts,
      jobId: followUps.jobId,
      cancelledAt: followUps.cancelledAt,
      cancelledBy: followUps.cancelledBy,
      cancelReason: followUps.cancelReason,
      startedAt: followUps.startedAt,
      finishedAt: followUps.finishedAt,
      outcome: followUps.outcome,
      outcomeKind: followUps.outcomeKind,
      waitForEvent: followUps.waitForEvent,
      createdAt: followUps.createdAt,
      updatedAt: followUps.updatedAt,
      jobStatus: jobs.status,
      jobAvailableAt: jobs.availableAt,
      jobAttempts: jobs.attempts,
    })
    .from(followUps)
    .leftJoin(jobs, eq(jobs.id, followUps.jobId))
    .where(eq(followUps.agentId, agentId))
    .orderBy(desc(followUps.dueAt), desc(followUps.createdAt))
    .limit(100);

  return rows;
}

export async function listActivityEventsForAgent(agentId: string, limit = 50) {
  await requireAdmin();
  return db()
    .select()
    .from(agentActivityEvents)
    .where(eq(agentActivityEvents.agentId, agentId))
    .orderBy(desc(agentActivityEvents.createdAt))
    .limit(limit);
}
