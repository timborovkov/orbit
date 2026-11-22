'use server';

import { revalidatePath } from 'next/cache';

import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { memoryDate, memoryFact, personMemoryValue } from '@/lib/runtime/memory/types';
import { saveAgentMemory, saveMemoryRetention } from '@/lib/server/memory-mutations';

const editKey = z.object({ agentId: z.uuid(), id: z.uuid(), revision: z.uuid() });
const correctionDates = z.object({
  expiresOn: memoryDate.nullable(),
  reviewOn: memoryDate.nullable(),
});
const correctionFields = z.union([
  correctionDates.extend({ fact: memoryFact }),
  correctionDates.extend({ personValue: personMemoryValue }),
]);

async function memoryAction(form: FormData, remove: boolean) {
  await checkOrigin();
  const actor = await requireAdmin();
  const key = editKey.safeParse({
    agentId: form.get('agentId'),
    id: form.get('id'),
    revision: form.get('revision'),
  });
  if (!key.success) return { error: 'Memory unavailable.' };
  const correction = remove
    ? undefined
    : correctionFields.safeParse({
        ...(form.has('personValue')
          ? { personValue: form.get('personValue') }
          : { fact: form.get('fact') }),
        expiresOn: form.get('expiresOn') || null,
        reviewOn: form.get('reviewOn') || null,
      });
  if (correction && !correction.success) {
    return { error: 'Enter a valid fact or person value and valid dates.' };
  }

  const result = await saveAgentMemory(actor, key.data, correction?.data);
  if (!('error' in result)) revalidatePath(`/agents/${key.data.agentId}`);
  return result;
}

export async function correctMemory(form: FormData) {
  return memoryAction(form, false);
}

export async function removeMemory(form: FormData) {
  return memoryAction(form, true);
}

export async function configureMemoryRetention(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const days = z.coerce.number().int().min(1).max(3650).nullable();
  const parsed = z
    .object({
      agentId: z.uuid(),
      intervalDays: z
        .union([z.literal('1'), z.literal('7')])
        .transform((value) => (value === '1' ? 1 : 7)),
      factDays: days,
      noteDays: days,
      outcomeDays: days,
    })
    .safeParse({
      agentId: form.get('agentId'),
      intervalDays: form.get('intervalDays'),
      factDays: form.get('factDays') || null,
      noteDays: form.get('noteDays') || null,
      outcomeDays: form.get('outcomeDays') || null,
    });
  if (!parsed.success)
    return { error: 'Choose a schedule and enter retention between 1 and 3,650 days.' };
  const { agentId, ...values } = parsed.data;
  const result = await saveMemoryRetention(actor, agentId, values);
  if (!('error' in result)) revalidatePath(`/agents/${agentId}`);
  return result;
}
