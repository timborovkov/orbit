'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { budgetDefaults, budgetsSchema } from '@/lib/budgets';
import { lifecycleSchema } from '@/lib/lifecycle';
import { persistBudgets, persistLifecycle } from '@/lib/server/lifecycle-mutations';

const uuid = z.uuid();

export async function setAgentLifecycle(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const agentId = uuid.parse(form.get('agentId'));
  const lifecycle = lifecycleSchema.safeParse(form.get('lifecycle'));
  if (!lifecycle.success) return { error: 'Choose a valid lifecycle state.' };
  const result = await persistLifecycle(actor, agentId, lifecycle.data);
  revalidatePath('/');
  revalidatePath(`/agents/${agentId}`);
  return result;
}

export async function saveAgentBudgets(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const agentId = uuid.parse(form.get('agentId'));
  const raw = Object.fromEntries(
    Object.keys(budgetDefaults).map((key) => [key, form.get(key)]),
  );
  const parsed = budgetsSchema.safeParse({
    dailySpendCents: Number(raw.dailySpendCents),
    monthlySpendCents: Number(raw.monthlySpendCents),
    dailyRequests: Number(raw.dailyRequests),
    monthlyRequests: Number(raw.monthlyRequests),
    dailyOutboundActions: Number(raw.dailyOutboundActions),
    monthlyOutboundActions: Number(raw.monthlyOutboundActions),
    maxConcurrentRuns: Number(raw.maxConcurrentRuns),
    maxToolStepsPerRun: Number(raw.maxToolStepsPerRun),
    runDeadlineSeconds: Number(raw.runDeadlineSeconds),
  });
  if (!parsed.success) return { error: 'Check budget values stay within allowed ranges.' };
  const result = await persistBudgets(actor, agentId, parsed.data);
  revalidatePath(`/agents/${agentId}`);
  return result;
}
