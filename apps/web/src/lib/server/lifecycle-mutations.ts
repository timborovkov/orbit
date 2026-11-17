import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';

import { budgetDefaults, budgetsSchema, type AgentBudgets } from '@/lib/budgets';
import { db } from '@/lib/db';
import {
  lifecycleLabels,
  lifecycleSchema,
  shouldCancelPendingJobs,
  type LifecycleState,
} from '@/lib/lifecycle';
import { cancelPendingJobsForAgent } from '@/lib/queue/jobs';
import { agents, audit, runs } from '@/lib/schema';

export async function persistLifecycle(actor: string, agentId: string, next: LifecycleState) {
  const parsed = lifecycleSchema.safeParse(next);
  if (!parsed.success) return { error: 'Choose a valid lifecycle state.' as const };

  return await db().transaction(async (tx) => {
    const agent = (await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')).at(
      0,
    );
    if (!agent) return { error: 'Agent not found.' as const };
    if (agent.lifecycle === parsed.data) {
      return { message: `Lifecycle already ${lifecycleLabels[parsed.data].toLowerCase()}.` };
    }

    await tx.update(agents).set({ lifecycle: parsed.data }).where(eq(agents.id, agentId));
    await tx.insert(audit).values({
      actor,
      action: `Changed agent ${agentId} lifecycle to ${parsed.data}`,
    });

    if (shouldCancelPendingJobs(parsed.data)) {
      const includeClaimed = parsed.data === 'stopped';
      const cancelled = await cancelPendingJobsForAgent(agentId, tx, { includeClaimed });
      if (parsed.data === 'stopped') {
        await tx
          .update(runs)
          .set({
            status: 'interrupted',
            finishedAt: new Date(),
            deferReason: 'Agent stopped; pending work cancelled.',
          })
          .where(and(eq(runs.agentId, agentId), inArray(runs.status, ['queued', 'running'])));
      } else if (parsed.data === 'paused') {
        await tx
          .update(runs)
          .set({
            status: 'interrupted',
            finishedAt: new Date(),
            deferReason: 'Agent paused; queued work cancelled.',
          })
          .where(and(eq(runs.agentId, agentId), eq(runs.status, 'queued')));
      }
      await tx.insert(audit).values({
        actor,
        action: includeClaimed
          ? `Cancelled ${cancelled} pending/claimed job(s) for agent ${agentId} on stopped`
          : `Cancelled ${cancelled} pending job(s) for agent ${agentId} on paused`,
      });
    }

    return {
      message:
        parsed.data === 'live'
          ? 'Live lifecycle saved. No external action adapters exist yet, so proposals stay suppressed.'
          : `Lifecycle set to ${lifecycleLabels[parsed.data].toLowerCase()}.`,
    };
  });
}

export async function persistBudgets(actor: string, agentId: string, budgets: AgentBudgets) {
  const parsed = budgetsSchema.safeParse({ ...budgetDefaults, ...budgets });
  if (!parsed.success) return { error: 'Check budget values stay within allowed ranges.' as const };

  const updated = await db().transaction(async (tx) => {
    const rows = await tx
      .update(agents)
      .set({ budgets: parsed.data })
      .where(eq(agents.id, agentId))
      .returning({ id: agents.id });
    if (!rows.length) return false;
    await tx.insert(audit).values({
      actor,
      action: `Updated budgets for agent ${agentId}`,
    });
    return true;
  });
  if (!updated) return { error: 'Agent not found.' as const };
  return { message: 'Budgets saved.' };
}
