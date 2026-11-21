'use server';

import { revalidatePath } from 'next/cache';

import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { memoryDate, memoryFact } from '@/lib/runtime/memory/types';
import { saveAgentMemory } from '@/lib/server/memory-mutations';

const editKey = z.object({ agentId: z.uuid(), id: z.uuid(), revision: z.uuid() });
const correctionFields = z.object({
  fact: memoryFact,
  expiresOn: memoryDate.nullable(),
  reviewOn: memoryDate.nullable(),
});

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
        fact: form.get('fact'),
        expiresOn: form.get('expiresOn') || null,
        reviewOn: form.get('reviewOn') || null,
      });
  if (correction && !correction.success) {
    return { error: 'Enter a company or project fact up to 500 characters and valid dates.' };
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
