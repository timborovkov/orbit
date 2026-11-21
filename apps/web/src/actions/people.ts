'use server';

import { revalidatePath } from 'next/cache';

import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import {
  removePersonContact,
  removePersonLink,
  savePersonContact,
  savePersonLink,
} from '@/lib/server/people-mutations';

const identityInput = z.object({
  id: z.uuid(),
  sourceId: z.uuid(),
  revision: z.coerce.number().int().min(0),
});
const reason = z.string().trim().min(1).max(1000);

function identityValues(form: FormData, prefix: 'identity' | 'target') {
  return {
    id: form.get(prefix),
    sourceId: form.get(`${prefix}Source`),
    revision: form.get(`${prefix}Revision`),
  };
}

function refreshPeople(result: { error?: string; message?: string }) {
  if (!result.error) {
    revalidatePath('/people');
    revalidatePath('/people/[id]', 'page');
    revalidatePath('/agents/[id]', 'page');
  }
  return result;
}

export async function linkPersonIdentity(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const input = z.object({ identity: identityInput, target: identityInput, reason }).safeParse({
    identity: identityValues(form, 'identity'),
    target: identityValues(form, 'target'),
    reason: form.get('reason'),
  });
  if (!input.success) return { error: 'Choose evidence for both identities and enter a reason.' };
  return refreshPeople(await savePersonLink(actor, input.data));
}

export async function unlinkPersonIdentity(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const input = z.object({ identity: identityInput, reason }).safeParse({
    identity: identityValues(form, 'identity'),
    reason: form.get('reason'),
  });
  if (!input.success) return { error: 'Enter the reason for unlinking.' };
  return refreshPeople(await removePersonLink(actor, input.data));
}

export async function addPersonContact(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const personId = z.uuid().safeParse(form.get('personId'));
  const kind = z.enum(['phone', 'instagram']).safeParse(form.get('kind'));
  if (!personId.success || !kind.success) return { error: 'Invalid contact method.' };
  const label = (
    kind.data === 'phone'
      ? z
          .string()
          .trim()
          .regex(/^\+[1-9]\d{1,14}$/)
      : z
          .string()
          .trim()
          .regex(/^@?[a-zA-Z0-9_.]{1,30}$/)
          .transform((handle) => `@${handle.replace(/^@/, '').toLowerCase()}`)
  ).safeParse(form.get('label'));
  if (!label.success)
    return {
      error:
        kind.data === 'phone'
          ? 'Enter a phone number in international format, such as +442079460000.'
          : 'Enter a valid Instagram handle.',
    };
  const accountId = z
    .string()
    .trim()
    .regex(/^[\w-]{0,128}$/)
    .safeParse(form.get('providerAccountId') ?? '');
  if (!accountId.success) return { error: 'Enter a valid Instagram account ID.' };
  return refreshPeople(
    await savePersonContact(actor, {
      personId: personId.data,
      kind: kind.data,
      label: label.data,
      providerAccountId: kind.data === 'instagram' ? accountId.data || null : null,
    }),
  );
}

export async function deletePersonContact(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const input = z.object({ personId: z.uuid(), contactId: z.uuid() }).safeParse({
    personId: form.get('personId'),
    contactId: form.get('contactId'),
  });
  if (!input.success) return { error: 'Invalid contact method.' };
  return refreshPeople(await removePersonContact(actor, input.data.personId, input.data.contactId));
}
