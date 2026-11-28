'use server';

import { revalidatePath } from 'next/cache';

import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { introductionDecision, peopleGrant } from '@/lib/runtime/introductions/types';
import { persistPeopleGrant, recordIntroductionConsent } from '@/lib/server/introduction-mutations';

export async function savePeopleGrant(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const parsed = z
    .object({
      agentId: z.uuid(),
      type: peopleGrant,
      enabled: z.enum(['true', 'false']),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: 'Choose a valid People permission.' };
  const { agentId, type, enabled } = parsed.data;
  const result = await persistPeopleGrant(actor, agentId, type, enabled === 'true');
  revalidatePath(`/agents/${agentId}`);
  return result;
}

export async function saveIntroductionConsent(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const parsed = z
    .object({
      introductionId: z.uuid(),
      personId: z.uuid(),
      decision: introductionDecision,
      evidence: z.string().trim().min(1).max(1000),
      disclosureDigest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: 'Choose a decision and enter an evidence reference.' };
  const result = await recordIntroductionConsent({ actor, ...parsed.data });
  revalidatePath('/people/introductions');
  revalidatePath(`/people/introductions/${parsed.data.introductionId}`);
  revalidatePath('/approvals');
  return result;
}
