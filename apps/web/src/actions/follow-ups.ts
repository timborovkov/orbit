'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { cancelFollowUp, scheduleFollowUp } from '@/lib/server/follow-up-mutations';

async function agentParams(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const agentId = z.uuid().safeParse(form.get('agentId'));
  if (!agentId.success) return { error: 'Agent not found.' as const };
  return { actor, agentId: agentId.data };
}

export async function scheduleAgentFollowUp(form: FormData) {
  const parsed = await agentParams(form);
  if ('error' in parsed) return parsed;

  const subject = z.string().trim().min(1).max(200).safeParse(form.get('subject'));
  if (!subject.success) return { error: 'Enter a subject for the follow-up.' };

  const note = z
    .string()
    .trim()
    .max(2000)
    .safeParse(form.get('note') ?? '');
  if (!note.success) return { error: 'Keep the note under 2000 characters.' };

  const dueRaw = form.get('dueAt');
  const dueAt = z.coerce.date().safeParse(typeof dueRaw === 'string' ? dueRaw : undefined);
  if (!dueAt.success) return { error: 'Choose a valid due time.' };

  const result = await scheduleFollowUp(parsed.actor, {
    agentId: parsed.agentId,
    subject: subject.data,
    note: note.data,
    dueAt: dueAt.data,
  });
  if (!('error' in result)) revalidatePath(`/agents/${parsed.agentId}`);
  return result;
}

export async function cancelAgentFollowUp(form: FormData) {
  const parsed = await agentParams(form);
  if ('error' in parsed) return parsed;

  const followUpId = z.uuid().safeParse(form.get('followUpId'));
  if (!followUpId.success) return { error: 'Follow-up not found.' };

  const result = await cancelFollowUp(parsed.actor, parsed.agentId, followUpId.data);
  if (!('error' in result)) revalidatePath(`/agents/${parsed.agentId}`);
  return result;
}
