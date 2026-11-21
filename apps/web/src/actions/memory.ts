'use server';

import { revalidatePath } from 'next/cache';

import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { memoryDate, memoryFact, personMemoryValue } from '@/lib/runtime/memory/types';
import { saveAgentMemory } from '@/lib/server/memory-mutations';

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
