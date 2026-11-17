'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { recordConsent } from '@/lib/policy/consent';
import { reviewProposedAction } from '@/lib/policy/gateway';
import { consentScope, proposalTypes, recipientId } from '@/lib/policy/scopes';
import { persistApprovalTools } from '@/lib/server/lifecycle-mutations';

export async function saveApprovalTools(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const agentId = z.uuid().parse(form.get('agentId'));
  const tools = z
    .array(z.enum(proposalTypes))
    .max(proposalTypes.length)
    .safeParse(form.getAll('tool'));
  if (!tools.success) return { error: 'Choose valid action types.' };
  const saved = await persistApprovalTools(actor, agentId, [...new Set(tools.data)]);
  if (!saved) return { error: 'Agent not found.' };
  revalidatePath(`/agents/${agentId}`);
  return { message: 'Approval requirements saved.' };
}

export async function saveConsent(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const parsed = z
    .object({
      agentId: z.uuid(),
      recipient: recipientId,
      scope: consentScope,
      evidence: z.string().trim().min(1).max(1000),
      outcome: z.enum(['grant', 'revoke']),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: 'Enter a recipient, a scope, and an evidence reference.' };
  const { outcome, ...fields } = parsed.data;
  const result = await recordConsent({ ...fields, actor, granted: outcome === 'grant' });
  revalidatePath(`/agents/${fields.agentId}`);
  return result;
}

export async function reviewProposal(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const parsed = z
    .object({
      agentId: z.uuid(),
      intentId: z.uuid(),
      decision: z.enum(['approved', 'rejected']),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: 'Choose a valid proposal and decision.' };
  const { agentId, intentId, decision } = parsed.data;
  const result = await reviewProposedAction(actor, agentId, intentId, decision);
  revalidatePath(`/agents/${agentId}`);
  return result;
}
