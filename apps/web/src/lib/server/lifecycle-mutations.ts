import 'server-only';

import { eq } from 'drizzle-orm';

import { budgetDefaults, budgetsSchema, type AgentBudgets } from '@/lib/budgets';
import { db } from '@/lib/db';
import {
  lifecycleLabels,
  lifecycleSchema,
  shouldCancelPendingJobs,
  type LifecycleState,
} from '@/lib/lifecycle';
import { cancelWorkForLifecycle } from '@/lib/lifecycle-work';
import { agents, audit } from '@/lib/schema';

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
      action: `Changed ${agent.name} lifecycle to ${parsed.data}`,
    });

    if (shouldCancelPendingJobs(parsed.data)) {
      const cancelledIds = await cancelWorkForLifecycle(
        agentId,
        parsed.data === 'stopped' ? 'stopped' : 'paused',
        tx,
      );
      await tx.insert(audit).values({
        actor,
        action:
          parsed.data === 'stopped'
            ? `Cancelled ${cancelledIds.length} pending/claimed job(s) for ${agent.name} on stopped`
            : `Cancelled ${cancelledIds.length} pending job(s) for ${agent.name} on paused`,
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
      .returning({ id: agents.id, name: agents.name });
    if (!rows.length) return false;
    await tx.insert(audit).values({
      actor,
      action: `Updated budgets for ${rows[0].name}`,
    });
    return true;
  });
  if (!updated) return { error: 'Agent not found.' as const };
  return { message: 'Budgets saved.' };
}

export async function persistApprovalTools(
  actor: string,
  agentId: string,
  approvalTools: string[],
  options: {
    approvalExpiresAfterHours?: number | null;
    approvalOnReject?: 'continue' | 'end';
    approvalSpendCents?: number | null;
  } = {},
) {
  return db().transaction(async (tx) => {
    const rows = await tx
      .update(agents)
      .set({
        approvalTools,
        ...(options.approvalExpiresAfterHours !== undefined
          ? { approvalExpiresAfterHours: options.approvalExpiresAfterHours }
          : {}),
        ...(options.approvalOnReject !== undefined
          ? { approvalOnReject: options.approvalOnReject }
          : {}),
        ...(options.approvalSpendCents !== undefined
          ? { approvalSpendCents: options.approvalSpendCents }
          : {}),
      })
      .where(eq(agents.id, agentId))
      .returning({ id: agents.id, name: agents.name });
    if (!rows.length) return false;
    await tx
      .insert(audit)
      .values({ actor, action: `Changed approval requirements for ${rows[0].name}` });
    return true;
  });
}
