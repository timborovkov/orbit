import 'server-only';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { enqueueJob } from '@/lib/queue/jobs';
import {
  FOLLOW_UP_ACTIVITY_KINDS,
  FOLLOW_UP_JOB_TYPE,
  scheduleFollowUpInputSchema,
} from '@/lib/runtime/follow-ups/types';
import { agentActivityEvents, agents, audit, followUps, jobs } from '@/lib/schema';

export async function scheduleFollowUp(
  actor: string,
  input: { agentId: string; subject: string; note?: string; dueAt: Date },
) {
  const parsed = scheduleFollowUpInputSchema.safeParse({
    agentId: input.agentId,
    subject: input.subject,
    note: input.note ?? '',
    dueAt: input.dueAt,
  });
  if (!parsed.success) return { error: 'Check the subject and due time.' as const };

  const followUpId = randomUUID();
  const result = await db().transaction(async (tx) => {
    const agent = (
      await tx
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.id, parsed.data.agentId))
        .for('update')
    ).at(0);
    if (!agent) return { error: 'Agent not found.' as const };

    const job = await enqueueJob(tx, {
      type: FOLLOW_UP_JOB_TYPE,
      payload: { followUpId, agentId: agent.id },
      idempotencyKey: `followup:${followUpId}`,
      availableAt: parsed.data.dueAt,
    });

    await tx.insert(followUps).values({
      id: followUpId,
      agentId: agent.id,
      source: 'admin',
      createdBy: actor,
      subject: parsed.data.subject,
      note: parsed.data.note,
      dueAt: parsed.data.dueAt,
      status: 'scheduled',
      jobId: job.id,
      metadata: {},
    });

    await tx.insert(audit).values({
      actor,
      action: `Scheduled follow-up ${followUpId} for ${agent.name} due ${parsed.data.dueAt.toISOString()}`,
    });

    return { followUpId, jobId: job.id, message: 'Follow-up scheduled.' as const };
  });

  return result;
}

export async function cancelFollowUp(actor: string, agentId: string, followUpId: string) {
  const now = new Date();

  return db().transaction(async (tx) => {
    const agent = (
      await tx
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.id, agentId))
        .for('update')
    ).at(0);
    if (!agent) return { error: 'Agent not found.' as const };

    const row = (
      await tx
        .select()
        .from(followUps)
        .where(and(eq(followUps.id, followUpId), eq(followUps.agentId, agentId)))
        .for('update')
    ).at(0);
    if (!row) return { error: 'Follow-up not found.' as const };
    if (row.status !== 'scheduled') {
      return { error: `Follow-up is already ${row.status}.` as const };
    }

    if (row.jobId) {
      await tx
        .update(jobs)
        .set({
          status: 'cancelled',
          finishedAt: now,
          claimExpiresAt: null,
          claimedBy: null,
          updatedAt: now,
        })
        .where(and(eq(jobs.id, row.jobId), eq(jobs.status, 'pending')));
    }

    const outcome = `Follow-up cancelled by administrator: ${row.subject}.`;
    await tx
      .update(followUps)
      .set({
        status: 'cancelled',
        cancelledAt: now,
        cancelledBy: actor,
        cancelReason: 'Cancelled by administrator.',
        finishedAt: now,
        outcome,
        outcomeKind: 'cancelled',
        updatedAt: now,
      })
      .where(and(eq(followUps.id, followUpId), eq(followUps.status, 'scheduled')));

    await tx.insert(agentActivityEvents).values({
      agentId,
      followUpId,
      kind: FOLLOW_UP_ACTIVITY_KINDS.cancelled,
      summary: `Follow-up cancelled: ${row.subject}`,
      detail: outcome,
      createdAt: now,
    });

    await tx.insert(audit).values({
      actor,
      action: `Cancelled follow-up ${followUpId} for ${agent.name}`,
    });

    return { message: 'Follow-up cancelled.' as const };
  });
}
