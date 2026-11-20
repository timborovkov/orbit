'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { setEmailEnabled } from '@/lib/server/email-mutations';
import { reviewProposedAction } from '@/lib/server/policy-mutations';

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

export async function reviewEmailReply(input: {
  agentId: string;
  intentId: string;
  decision: 'approved' | 'rejected';
  draft?: string;
}) {
  await checkOrigin();
  const actor = await requireAdmin();
  const parsed = z
    .object({
      agentId: z.uuid(),
      intentId: z.uuid(),
      decision: z.enum(['approved', 'rejected']),
      draft: z.string().trim().min(1).max(8000).optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { error: 'Invalid reply review.' };

  const result = await reviewProposedAction(
    actor,
    parsed.data.agentId,
    parsed.data.intentId,
    parsed.data.decision,
    parsed.data.decision === 'approved' && parsed.data.draft
      ? { editedPayload: { draft: parsed.data.draft } }
      : {},
  );
  if (!('error' in result)) {
    revalidatePath(`/agents/${parsed.data.agentId}`);
    revalidatePath('/approvals');
  }
  return result;
}
