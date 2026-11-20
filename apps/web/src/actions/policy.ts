'use server';

import { revalidatePath } from 'next/cache';

import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { consentScope, proposalTypes, recipientId } from '@/lib/policy/scopes';
import { persistApprovalTools } from '@/lib/server/lifecycle-mutations';
import {
  persistConsentRequirements,
  recordConsent,
  reviewProposedAction,
  reviewProposedActionsBulk,
} from '@/lib/server/policy-mutations';

export async function saveApprovalTools(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const fields = z
    .object({ agentId: z.uuid(), configurationVersion: z.coerce.number().int().positive() })
    .safeParse(Object.fromEntries(form));
  if (!fields.success) return { error: 'Choose a valid agent and configuration.' };
  const { agentId, configurationVersion } = fields.data;
  const tools = z
    .array(z.enum(proposalTypes))
    .max(proposalTypes.length)
    .safeParse(form.getAll('tool'));
  if (!tools.success) return { error: 'Choose valid action types.' };

  const expiresValue = form.get('approvalExpiresAfterHours');
  const spendValue = form.get('approvalSpendDollars') ?? form.get('approvalSpendCents');
  const expiresRaw = typeof expiresValue === 'string' ? expiresValue.trim() : '';
  const spendRaw = typeof spendValue === 'string' ? spendValue.trim() : '';
  const onReject = z
    .enum(['continue', 'end'])
    .safeParse(form.get('approvalOnReject') ?? 'continue');
  if (!onReject.success) return { error: 'Choose how rejected proposals should affect the run.' };

  let approvalExpiresAfterHours: number | null = null;
  if (expiresRaw) {
    const parsed = z.coerce.number().int().min(1).max(720).safeParse(expiresRaw);
    if (!parsed.success) return { error: 'Expiry must be between 1 and 720 hours.' };
    approvalExpiresAfterHours = parsed.data;
  }

  let approvalSpendCents: number | null = null;
  if (spendRaw) {
    if (form.has('approvalSpendDollars')) {
      const dollars = z.coerce.number().min(0.01).max(1_000_000).safeParse(spendRaw);
      if (!dollars.success) return { error: 'Spend threshold must be a positive dollar amount.' };
      approvalSpendCents = Math.round(dollars.data * 100);
    } else {
      const parsed = z.coerce.number().int().min(1).max(100_000_000).safeParse(spendRaw);
      if (!parsed.success) return { error: 'Spend threshold must be a positive cent amount.' };
      approvalSpendCents = parsed.data;
    }
  }

  const result = await persistApprovalTools(actor, agentId, configurationVersion, {
    approvalTools: [...new Set(tools.data)],
    approvalExpiresAfterHours,
    approvalOnReject: onReject.data,
    approvalSpendCents,
  });
  revalidatePath(`/agents/${agentId}`);
  revalidatePath('/approvals');
  return result;
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

export async function saveConsentRequirements(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const agentId = z.uuid().parse(form.get('agentId'));
  const tools = z
    .array(consentScope)
    .max(consentScope.options.length)
    .safeParse(form.getAll('tool'));
  if (!tools.success) return { error: 'Choose valid action types.' };
  const result = await persistConsentRequirements(actor, agentId, [...new Set(tools.data)]);
  revalidatePath(`/agents/${agentId}`);
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
      draft: z.string().max(8000).optional(),
      note: z.string().max(1000).optional(),
    })
    .safeParse({
      agentId: form.get('agentId'),
      intentId: form.get('intentId'),
      decision: form.get('decision'),
      draft: typeof form.get('draft') === 'string' ? form.get('draft') : undefined,
      note: typeof form.get('note') === 'string' ? form.get('note') : undefined,
    });
  if (!parsed.success) return { error: 'Choose a valid proposal and decision.' };
  const { agentId, intentId, decision, draft, note } = parsed.data;
  const editedPayload =
    decision === 'approved' && draft !== undefined
      ? { draft: draft.length ? draft : null }
      : undefined;
  const result = await reviewProposedAction(actor, agentId, intentId, decision, {
    editedPayload,
    note: note ?? null,
  });
  revalidatePath(`/agents/${agentId}`);
  revalidatePath('/approvals');
  return result;
}

export async function reviewProposalsBulk(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const decision = z.enum(['approved', 'rejected']).safeParse(form.get('decision'));
  if (!decision.success) return { error: 'Choose approve or reject.' };
  const raw = form.getAll('selection');
  const items: { agentId: string; intentId: string }[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') return { error: 'Select valid proposals.' };
    const [agentId, intentId] = value.split(':');
    const parsed = z
      .object({ agentId: z.uuid(), intentId: z.uuid() })
      .safeParse({ agentId, intentId });
    if (!parsed.success) return { error: 'Select valid proposals.' };
    items.push(parsed.data);
  }
  const result = await reviewProposedActionsBulk(actor, items, decision.data);
  revalidatePath('/approvals');
  for (const item of items) revalidatePath(`/agents/${item.agentId}`);
  return result;
}
