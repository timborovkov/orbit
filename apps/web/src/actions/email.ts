'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { setEmailEnabled } from '@/lib/server/email-mutations';

export async function updateEmailMailbox(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const input = z.object({ agentId: z.uuid(), enabled: z.enum(['true', 'false']) }).safeParse({
    agentId: form.get('agentId'),
    enabled: form.get('enabled'),
  });
  if (!input.success) return { error: 'Invalid mailbox settings.' };
  const result = await setEmailEnabled(actor, input.data.agentId, input.data.enabled === 'true');
  if (!result.error) revalidatePath(`/agents/${input.data.agentId}`);
  return result;
}
