import 'server-only';

import { and, eq } from 'drizzle-orm';

import { approvalReviewLimit } from '@/lib/approvals/rules';
import { db } from '@/lib/db';
import { recipientConsentFailure } from '@/lib/policy/consent';
import { evaluateCandidate, loadPolicyContext } from '@/lib/policy/gateway';
import type { ConsentScope } from '@/lib/policy/scopes';
import {
  expireApproval,
  lockApprovalAgent,
  recordApprovalReviews,
  settleApprovalRun,
} from '@/lib/runtime/approval-work';
import { channelAction } from '@/lib/runtime/channels/registry';
import { isCommitmentTool } from '@/lib/runtime/follow-ups/types';
import { introductionDisclosureFailure } from '@/lib/runtime/introductions/disclosure';
import { INTRODUCTION_REVIEW } from '@/lib/runtime/introductions/types';
import { enqueueOutbound } from '@/lib/runtime/outbound/dispatch';
import { recordApprovalDecision } from '@/lib/runtime/telemetry';
import { actionIntents, agents, audit, policyDecisions, recipientConsents } from '@/lib/schema';

export async function persistConsentRequirements(
  actor: string,
  agentId: string,
  consentRequiredTools: ConsentScope[],
) {
  return db().transaction(async (tx) => {
    const agent = (
      await tx
        .update(agents)
        .set({ consentRequiredTools })
        .where(eq(agents.id, agentId))
        .returning({ name: agents.name })
    ).at(0);
    if (!agent) return { error: 'Agent not found.' };
    await tx
      .insert(audit)
      .values({ actor, action: `Changed recipient consent requirements for ${agent.name}` });
    return { message: 'Consent requirements saved.' };
  });
}

/** Record the recipient's decision and evidence. */
export async function recordConsent(input: {
  actor: string;
  agentId: string;
  recipient: string;
  scope: ConsentScope;
  evidence: string;
  granted: boolean;
}) {
  const { actor, agentId, scope, evidence, granted } = input;
  return db().transaction(async (tx) => {
    const agent = (
      await tx
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.id, agentId))
        .for('update')
    ).at(0);
    if (!agent) return { error: 'Agent not found.' };
    await tx
      .insert(recipientConsents)
      .values(input)
      .onConflictDoUpdate({
        target: [
          recipientConsents.agentId,
          recipientConsents.recipient,
          recipientConsents.scope,
          recipientConsents.introductionId,
        ],
        set: { granted, evidence, actor, updatedAt: new Date() },
      });
    await tx.insert(audit).values({
      actor,
      action: `${granted ? 'Granted' : 'Revoked'} ${scope} consent for ${agent.name}`,
    });
    return { message: granted ? 'Consent recorded.' : 'Consent revoked.' };
  });
}

type ReviewDecision = 'approved' | 'rejected';
type ReviewResult = { error: string } | { message: string };

export async function persistChannelGrant(
  actor: string,
  agentId: string,
  type: string,
  enabled: boolean,
) {
  const action = channelAction(type)?.action;
  if (!action || action.usesProviderGrant) return { error: 'Choose a valid channel action.' };
  return persistAgentToolGrant(actor, agentId, type, enabled, 'Channel permission saved.');
}

export async function persistCommitmentGrant(
  actor: string,
  agentId: string,
  type: string,
  enabled: boolean,
) {
  if (!isCommitmentTool(type)) return { error: 'Choose a valid commitment tool.' };
  return persistAgentToolGrant(actor, agentId, type, enabled, 'Commitment permission saved.');
}

async function persistAgentToolGrant(
  actor: string,
  agentId: string,
  type: string,
  enabled: boolean,
  message: string,
) {
  return db().transaction(async (tx) => {
    const agent = await lockApprovalAgent(tx, agentId);
    if (!agent) return { error: 'Agent not found.' };
    const tools = new Set(agent.enabledTools);
    if (enabled === tools.has(type)) return { message };
    if (enabled) tools.add(type);
    else tools.delete(type);
    await tx
      .update(agents)
      .set({ enabledTools: [...tools] })
      .where(eq(agents.id, agentId));
    await tx.insert(audit).values({
      actor,
      action: `${enabled ? 'Enabled' : 'Disabled'} ${type} for ${agent.name}`,
    });
    return { message };
  });
}

export async function reviewProposedAction(
  actor: string,
  agentId: string,
  intentId: string,
  reviewStatus: ReviewDecision,
  options: { editedPayload?: Record<string, unknown>; note?: string | null } = {},
): Promise<ReviewResult> {
  const result = await db().transaction(async (tx) => {
    const agent = await lockApprovalAgent(tx, agentId);
    if (!agent) return { error: 'Agent not found.' };
    const intent = (
      await tx
        .select()
        .from(actionIntents)
        .where(and(eq(actionIntents.id, intentId), eq(actionIntents.agentId, agentId)))
        .for('update')
    ).at(0);
    if (intent?.reviewStatus !== 'pending') {
      return { error: 'This proposal is no longer awaiting review.' };
    }

    const now = new Date();
    if (intent.reviewExpiresAt && intent.reviewExpiresAt <= now) {
      await expireApproval(tx, agent, intent, now);
      return {
        outcome: { error: 'This proposal expired and was rejected.' },
        runId: intent.runId,
        decision: 'rejected' as const,
      };
    }

    const approved = reviewStatus === 'approved';
    const payload =
      approved && options.editedPayload
        ? { ...intent.payload, ...options.editedPayload }
        : intent.payload;
    let approvalDecision: 'allow' | 'suppressed' = 'suppressed';
    if (approved && intent.actionType === INTRODUCTION_REVIEW) {
      if (options.editedPayload) {
        return { error: 'Changing the draft requires a new introduction and fresh consent.' };
      }
      const error = await introductionDisclosureFailure(tx, intent);
      if (error) {
        await tx.insert(policyDecisions).values({
          agentId,
          intentId,
          actionType: intent.actionType,
          decision: 'deny',
          reasons: [error],
          actor,
        });
        return { error };
      }
    } else if (approved) {
      const ctx = await loadPolicyContext(agentId, actor, intent.runId, tx);
      if (!ctx) return { error: 'Agent not found.' };
      if (ctx.lifecycle === 'shadow' && channelAction(intent.actionType)?.action.reviewInShadow) {
        return { error: 'Switch the agent to Live before approving this reply.' };
      }
      const consent = await recipientConsentFailure(
        tx,
        agentId,
        intent.actionType,
        intent.recipients,
        ctx.consentRequiredTools,
      );
      const policy = evaluateCandidate(
        ctx,
        {
          type: intent.actionType,
          idempotencyKey: intent.idempotencyKey,
          payload,
          recipients: intent.recipients,
        },
        consent,
        false,
        { skipApproval: true },
      );
      if (policy.decision === 'deny') {
        await tx.insert(policyDecisions).values({
          agentId,
          runId: intent.runId,
          actionType: intent.actionType,
          decision: 'deny',
          reasons: policy.reasons,
          intentId,
          actor,
        });
        return { error: policy.reasons.join(' ') };
      }
      approvalDecision = policy.decision === 'allow' ? 'allow' : 'suppressed';
      if (approvalDecision === 'allow') {
        const error = await channelAction(intent.actionType)?.action.validateApproval?.(tx, {
          ...intent,
          payload,
        });
        if (error) return { error };
      }
    }

    const reason = approved
      ? options.editedPayload
        ? 'Administrator approved this proposal with edits.'
        : 'Administrator approved this proposal.'
      : 'Administrator rejected this proposal.';
    await recordApprovalReviews(tx, [intent], {
      actor,
      agentName: agent.name,
      status: reviewStatus,
      reason,
      now,
      payload,
      note: options.note,
      decision: approved ? approvalDecision : 'deny',
    });

    if (approved && approvalDecision === 'allow') {
      await enqueueOutbound(
        tx,
        { ...intent, payload, reviewStatus: 'approved', decision: approvalDecision },
        actor,
      );
    }

    const settled = intent.runId && (await settleApprovalRun(tx, agent, intent.runId, actor));
    return {
      outcome: {
        message: approved
          ? approvalDecision === 'allow'
            ? 'Proposal approved and queued for send.'
            : 'Proposal approved.'
          : settled === 'ended'
            ? 'Proposal rejected; run ended.'
            : 'Proposal rejected.',
      },
      runId: intent.runId,
      decision: reviewStatus,
    };
  });

  if (result.error) return { error: result.error };
  if (!result.outcome) throw new Error('Review returned no outcome.');
  recordApprovalDecision({ intentId, agentId, runId: result.runId, decision: result.decision });
  return result.outcome;
}

export async function reviewProposedActionsBulk(
  actor: string,
  items: { agentId: string; intentId: string }[],
  reviewStatus: ReviewDecision,
) {
  if (items.length === 0) return { error: 'Select at least one proposal.' as const };
  if (items.length > approvalReviewLimit) {
    return { error: `Review at most ${approvalReviewLimit} proposals at once.` };
  }

  const settled = await Promise.allSettled(
    items.map(({ agentId, intentId }) =>
      reviewProposedAction(actor, agentId, intentId, reviewStatus),
    ),
  );
  const outcomes = settled.map((result, index) => {
    const intentId = items[index].intentId;
    if (result.status === 'rejected') {
      return { intentId, ok: false, message: 'Review could not be saved. Please retry.' };
    }
    if ('error' in result.value) return { intentId, ok: false, message: result.value.error };
    return { intentId, ok: true, message: result.value.message };
  });
  const succeeded = outcomes.filter((row) => row.ok).length;
  const failed = outcomes.length - succeeded;
  return {
    message: failed
      ? `${succeeded} succeeded, ${failed} failed. ${outcomes.find((row) => !row.ok)?.message ?? ''}`
      : `${succeeded} proposal${succeeded === 1 ? '' : 's'} ${reviewStatus}.`,
    outcomes,
  };
}
