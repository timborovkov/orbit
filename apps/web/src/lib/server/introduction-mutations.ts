import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import { lockApprovalAgent, recordApprovalReviews } from '@/lib/runtime/approval-work';
import { introductionEmailDisclosure } from '@/lib/runtime/email/introduction';
import {
  hasBothAgreements,
  introductionConsents,
  introductionDraft,
  validPeopleBindings,
} from '@/lib/runtime/introductions/disclosure';
import {
  INTRODUCTION_REVIEW,
  type IntroductionDecision,
  type PeopleGrant,
} from '@/lib/runtime/introductions/types';
import { EMAIL_INTRODUCTION_ACTION } from '@/lib/runtime/outbound/types';
import { lockPeople } from '@/lib/runtime/people/identity';
import {
  actionIntents,
  agents,
  audit,
  introductionProposals,
  policyDecisions,
  recipientConsents,
} from '@/lib/schema';

export async function persistPeopleGrant(
  actor: string,
  agentId: string,
  type: PeopleGrant,
  enabled: boolean,
) {
  return db().transaction(async (tx) => {
    const agent = await lockApprovalAgent(tx, agentId);
    if (!agent) return { error: 'Agent not found.' };
    if (agent.enabledTools.includes(type) === enabled)
      return { message: 'People permission saved.' };
    await tx
      .update(agents)
      .set({
        enabledTools: enabled
          ? [...agent.enabledTools, type]
          : agent.enabledTools.filter((tool) => tool !== type),
      })
      .where(eq(agents.id, agentId));
    await tx.insert(audit).values({
      actor,
      action: `${enabled ? 'Enabled' : 'Disabled'} ${type} for ${agent.name}`,
    });
    return { message: 'People permission saved.' };
  });
}

async function prepareReview(
  tx: Tx,
  proposal: typeof introductionProposals.$inferSelect,
  agent: typeof agents.$inferSelect,
  actor: string,
  now: Date,
  disclosure: Awaited<ReturnType<typeof introductionEmailDisclosure>>,
) {
  const actionType = disclosure ? EMAIL_INTRODUCTION_ACTION : INTRODUCTION_REVIEW;
  const reasons = ['Both people agreed. An administrator must review this introduction.'];
  const [intent] = await tx
    .insert(actionIntents)
    .values({
      actionType,
      agentId: agent.id,
      idempotencyKey: disclosure
        ? `email-introduction:${proposal.id}`
        : `introduction-review:${proposal.id}`,
      recipients: disclosure?.to ?? [proposal.firstPersonId, proposal.secondPersonId],
      payload: disclosure ?? { introductionId: proposal.id, draft: introductionDraft(proposal) },
      decision: 'needs-approval',
      reasons,
      reviewStatus: 'pending',
      reviewExpiresAt: agent.approvalExpiresAfterHours
        ? new Date(now.getTime() + agent.approvalExpiresAfterHours * 3_600_000)
        : null,
    })
    .returning({ id: actionIntents.id });
  await tx
    .update(introductionProposals)
    .set({ reviewIntentId: intent.id })
    .where(eq(introductionProposals.id, proposal.id));
  await tx.insert(policyDecisions).values({
    intentId: intent.id,
    actionType,
    agentId: agent.id,
    actor,
    decision: 'needs-approval',
    reasons,
  });
}

export async function recordIntroductionConsent(input: {
  actor: string;
  introductionId: string;
  personId: string;
  decision: IntroductionDecision;
  evidence: string;
  disclosureDigest?: string;
}) {
  return db().transaction(async (tx) => {
    const [owner] = await tx
      .select({ agentId: introductionProposals.agentId })
      .from(introductionProposals)
      .where(eq(introductionProposals.id, input.introductionId));
    const agent = owner && (await lockApprovalAgent(tx, owner.agentId));
    if (!agent) return { error: 'Introduction not found.' };

    const [proposal] = await tx
      .select()
      .from(introductionProposals)
      .where(
        and(
          eq(introductionProposals.id, input.introductionId),
          eq(introductionProposals.agentId, agent.id),
        ),
      )
      .for('update');
    if (!proposal || ![proposal.firstPersonId, proposal.secondPersonId].includes(input.personId)) {
      return { error: 'Choose a person on this introduction.' };
    }

    const decisions = await introductionConsents(tx, proposal);
    const prior = decisions.find(
      ({ recipient }) => recipient === input.personId,
    )?.introductionDecision;
    if (input.decision === prior) return { message: 'Decision already recorded.' };
    const allowed = input.decision === 'revoked' ? prior === 'agreed' : !prior;
    if (!allowed) {
      return { error: 'This consent decision cannot be changed.' };
    }
    let disclosure: Awaited<ReturnType<typeof introductionEmailDisclosure>> = null;
    if (input.decision === 'agreed') {
      await lockPeople(tx);
      if (!(await validPeopleBindings(tx, proposal))) {
        return { error: 'A People identity or its source changed. Create a new introduction.' };
      }
      if (proposal.disclosureVersion === 2) {
        disclosure = await introductionEmailDisclosure(tx, proposal);
        if (
          !disclosure ||
          disclosure.digest !== input.disclosureDigest ||
          decisions.some(
            (decision) =>
              decision.introductionDecision === 'agreed' &&
              decision.disclosureDigest !== disclosure?.digest,
          )
        ) {
          return {
            error:
              'The email disclosure is unavailable or changed. Review the current details and obtain fresh consent.',
          };
        }
      }
    }

    const now = new Date();
    const values = {
      granted: input.decision === 'agreed',
      introductionDecision: input.decision,
      evidence: input.evidence,
      disclosureDigest: disclosure?.digest ?? null,
      actor: input.actor,
      updatedAt: now,
    };
    const [consent] = await tx
      .insert(recipientConsents)
      .values({
        ...values,
        agentId: agent.id,
        scope: 'introduce',
        recipient: input.personId,
        introductionId: proposal.id,
      })
      .onConflictDoUpdate({
        target: [
          recipientConsents.agentId,
          recipientConsents.recipient,
          recipientConsents.scope,
          recipientConsents.introductionId,
        ],
        set: values,
      })
      .returning();

    await tx.insert(audit).values({
      actor: input.actor,
      action: `Recorded ${input.decision} for person ${input.personId} on introduction ${proposal.id}`,
    });
    if (input.decision === 'agreed') {
      if (!proposal.reviewIntentId && hasBothAgreements(proposal, [...decisions, consent])) {
        await prepareReview(tx, proposal, agent, input.actor, now, disclosure);
        return { message: 'Both people agreed. Draft ready for review.' };
      }
      return { message: 'Agreement recorded.' };
    }
    if (proposal.reviewIntentId) {
      const [intent] = await tx
        .select()
        .from(actionIntents)
        .where(
          and(
            eq(actionIntents.id, proposal.reviewIntentId),
            eq(actionIntents.agentId, agent.id),
            inArray(actionIntents.actionType, [INTRODUCTION_REVIEW, EMAIL_INTRODUCTION_ACTION]),
          ),
        )
        .for('update');
      const reason =
        input.decision === 'revoked'
          ? 'A participant revoked consent for this introduction.'
          : 'A participant declined this introduction.';
      if (intent?.reviewStatus === 'pending') {
        await recordApprovalReviews(tx, [intent], {
          actor: input.actor,
          agentName: agent.name,
          status: 'rejected',
          reason,
          now,
          note: reason,
        });
      } else if (intent?.reviewStatus === 'approved') {
        await tx.insert(policyDecisions).values({
          intentId: intent.id,
          actionType: intent.actionType,
          agentId: agent.id,
          actor: input.actor,
          decision: 'deny',
          reasons: [reason],
        });
      }
    }
    return { message: input.decision === 'revoked' ? 'Consent revoked.' : 'Refusal recorded.' };
  });
}
