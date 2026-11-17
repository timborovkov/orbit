import 'server-only';

import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { missingRecipientConsent } from '@/lib/policy/consent';
import { evaluateCandidate, loadPolicyContext } from '@/lib/policy/gateway';
import type { ConsentScope } from '@/lib/policy/scopes';
import {
  actionIntents,
  agents,
  audit,
  policyDecisions,
  recipientConsents,
  runs,
} from '@/lib/schema';

/** Administrator consent grant/revoke — web mutation path only. */
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
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('update')
    ).at(0);
    if (!agent) return { error: 'Agent not found.' };
    await tx
      .insert(recipientConsents)
      .values(input)
      .onConflictDoUpdate({
        target: [recipientConsents.agentId, recipientConsents.recipient, recipientConsents.scope],
        set: { granted, evidence, actor, updatedAt: new Date() },
      });
    // Record the decision and its evidence without including a recipient identifier in the overview audit feed.
    await tx.insert(audit).values({
      actor,
      action: `${granted ? 'Granted' : 'Revoked'} ${scope} consent for agent ${agentId}`,
    });
    return { message: granted ? 'Consent recorded.' : 'Consent revoked.' };
  });
}

/** Administrator proposal review — web mutation path only. */
export async function reviewProposedAction(
  actor: string,
  agentId: string,
  intentId: string,
  reviewStatus: 'approved' | 'rejected',
) {
  return db().transaction(async (tx) => {
    const agent = (
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('update')
    ).at(0);
    if (!agent) return { error: 'Agent not found.' };
    const intent = (
      await tx
        .select()
        .from(actionIntents)
        .where(and(eq(actionIntents.id, intentId), eq(actionIntents.agentId, agentId)))
        .for('update')
    ).at(0);
    if (intent?.reviewStatus !== 'pending')
      return { error: 'This proposal is no longer awaiting review.' };

    const ctx = await loadPolicyContext(agentId, actor, intent.runId, tx);
    if (!ctx) return { error: 'Agent not found.' };
    const consentFailure = await missingRecipientConsent(
      tx,
      agentId,
      intent.actionType,
      intent.recipients,
    );
    const policy = evaluateCandidate(
      ctx,
      { type: intent.actionType, idempotencyKey: intent.idempotencyKey },
      consentFailure,
    );
    const run = intent.runId
      ? (await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, intent.runId))).at(0)
      : undefined;
    const approvalBlock =
      (run && run.status !== 'completed'
        ? 'The simulation must complete before approval.'
        : null) ?? (policy.decision === 'deny' ? policy.reasons.join(' ') : null);

    const reviewBlocked = reviewStatus === 'approved' && approvalBlock !== null;
    const decision = reviewStatus === 'approved' && !reviewBlocked ? 'suppressed' : 'deny';
    const reason = reviewBlocked
      ? approvalBlock
      : reviewStatus === 'approved'
        ? 'Administrator approved this proposal for simulation.'
        : 'Administrator rejected this proposal.';
    await tx.insert(policyDecisions).values({
      agentId,
      runId: intent.runId,
      actionType: intent.actionType,
      decision,
      reasons: [reason],
      intentId,
      actor,
    });
    if (reviewBlocked) return { error: approvalBlock };
    await tx
      .update(actionIntents)
      .set({
        decision,
        reasons: [reason],
        reviewStatus,
        reviewedBy: actor,
        reviewedAt: new Date(),
      })
      .where(eq(actionIntents.id, intentId));
    return {
      message:
        reviewStatus === 'approved' ? 'Proposal approved for simulation.' : 'Proposal rejected.',
    };
  });
}
