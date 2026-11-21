'use server';

import { revalidatePath } from 'next/cache';

import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import {
  createEvaluationCaseFromSource,
  enqueueEvaluationComparison,
} from '@/lib/server/evaluation-mutations';

const titleSchema = z.string().trim().min(1).max(200);
export async function saveCaseFromRun(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const parsed = z
    .object({
      agentId: z.uuid(),
      runId: z.uuid(),
      title: titleSchema,
    })
    .safeParse({
      agentId: form.get('agentId'),
      runId: form.get('runId'),
      title: form.get('title'),
    });
  if (!parsed.success) return { error: 'Invalid case details.' };

  const result = await createEvaluationCaseFromSource(actor, {
    agentId: parsed.data.agentId,
    title: parsed.data.title,
    sourceKind: 'channel',
    sourceRunId: parsed.data.runId,
    caseInput: '',
  });
  if (!('error' in result)) {
    revalidatePath('/evaluations');
    revalidatePath(`/agents/${parsed.data.agentId}`);
  }
  return result;
}

export async function saveCaseFromEmailMessage(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  // Body is rebuilt server-side from the message; do not apply the playground 16k limit.
  const parsed = z
    .object({
      agentId: z.uuid(),
      messageId: z.uuid(),
      title: titleSchema,
      input: z.string().optional(),
    })
    .safeParse({
      agentId: form.get('agentId'),
      messageId: form.get('messageId'),
      title: form.get('title'),
      input: form.get('input') ?? undefined,
    });
  if (!parsed.success) return { error: 'Invalid case details.' };

  const result = await createEvaluationCaseFromSource(actor, {
    agentId: parsed.data.agentId,
    title: parsed.data.title,
    sourceKind: 'email',
    sourceEmailMessageId: parsed.data.messageId,
    // Replaced server-side by buildEmailDraftInput(); body length is not validated here.
    caseInput: parsed.data.input?.trim() ?? '',
    recipients: [],
  });
  if (!('error' in result)) {
    revalidatePath('/evaluations');
    revalidatePath(`/agents/${parsed.data.agentId}`);
  }
  return result;
}

export async function startComparison(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const parsed = z
    .object({
      agentId: z.uuid(),
      caseId: z.uuid(),
      leftConfigurationId: z.uuid(),
      rightConfigurationId: z.uuid(),
    })
    .safeParse({
      agentId: form.get('agentId'),
      caseId: form.get('caseId'),
      leftConfigurationId: form.get('leftConfigurationId'),
      rightConfigurationId: form.get('rightConfigurationId'),
    });
  if (!parsed.success) return { error: 'Select a case and two configurations.' };

  const result = await enqueueEvaluationComparison(actor, parsed.data);
  if (!('error' in result)) {
    revalidatePath('/evaluations');
    revalidatePath(`/evaluations/${result.comparisonId}`);
    revalidatePath(`/agents/${parsed.data.agentId}`);
  }
  return result;
}
