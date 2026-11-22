import { and, eq, lte, sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import { agents } from '@/lib/schema';

export const MEMORY_MAINTENANCE_JOB = 'memory.maintain';

/** Called by worker recovery. The hourly suffix allows retry after a dead job. */
export async function scheduleMemoryMaintenance() {
  await db().execute(sql`
    INSERT INTO jobs (type, payload, idempotency_key)
    SELECT ${MEMORY_MAINTENANCE_JOB}, jsonb_build_object('agentId', policy.id),
      ${MEMORY_MAINTENANCE_JOB} || ':' || policy.id || ':' ||
        floor(extract(epoch FROM policy.memory_next_maintenance_at)) || ':' || floor(extract(epoch FROM now()) / 3600)
    FROM agents policy
    WHERE policy.memory_next_maintenance_at <= now()
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE type = ${MEMORY_MAINTENANCE_JOB}
        AND status IN ('pending', 'claimed') AND payload->>'agentId' = policy.id::text)
    ON CONFLICT DO NOTHING
  `);
}

export async function processMemoryMaintenance(agentId: string) {
  await db().transaction(async (tx) => {
    const [policy] = await tx
      .select({
        factDays: agents.memoryFactRetentionDays,
        noteDays: agents.memoryNoteRetentionDays,
        outcomeDays: agents.memoryOutcomeRetentionDays,
        intervalDays: agents.memoryMaintenanceIntervalDays,
      })
      .from(agents)
      .where(and(eq(agents.id, agentId), lte(agents.memoryNextMaintenanceAt, sql`now()`)))
      .for('update');
    if (!policy) return;
    const cutoff = (days: number | null) => sql`now() - ${days}::integer * interval '24 hours'`;
    const retainedSince = sql`CASE subject_kind
      WHEN 'note' THEN ${cutoff(policy.noteDays)}
      WHEN 'outcome' THEN ${cutoff(policy.outcomeDays)}
      ELSE ${cutoff(policy.factDays)}
    END`;
    await tx.execute(sql`
      DELETE FROM agent_memory_evidence_revisions
      WHERE agent_id = ${agentId} AND learned_at < ${retainedSince}
    `);
    await tx.execute(sql`
      DELETE FROM agent_memories WHERE agent_id = ${agentId} AND learned_at < ${retainedSince}
    `);
    await tx.execute(sql`
      DELETE FROM person_relationship_notes WHERE agent_id = ${agentId} AND created_at < ${cutoff(policy.noteDays)}
    `);
    await tx
      .update(agents)
      .set({
        memoryNextMaintenanceAt: sql`now() + ${policy.intervalDays}::integer * interval '24 hours'`,
      })
      .where(eq(agents.id, agentId));
  });
}
