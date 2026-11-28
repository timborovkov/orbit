import 'server-only';

import { and, desc, eq, inArray } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { introductionEmailDisclosure } from '@/lib/runtime/email/introduction';
import {
  introductionConsents,
  introductionParties,
  validPeopleBindings,
} from '@/lib/runtime/introductions/disclosure';
import { INTRODUCTION_REVIEW } from '@/lib/runtime/introductions/types';
import { EMAIL_INTRODUCTION_ACTION } from '@/lib/runtime/outbound/types';
import { actionIntents, agents, introductionProposals, outboundActions } from '@/lib/schema';

const pageSize = 40;

export async function listIntroductions(page: number) {
  await requireAdmin();
  const rows = await db()
    .select({
      id: introductionProposals.id,
      first: introductionProposals.firstDisclosure,
      second: introductionProposals.secondDisclosure,
      agentName: agents.name,
      createdAt: introductionProposals.createdAt,
    })
    .from(introductionProposals)
    .innerJoin(agents, eq(agents.id, introductionProposals.agentId))
    .orderBy(desc(introductionProposals.createdAt), desc(introductionProposals.id))
    .limit(pageSize + 1)
    .offset((page - 1) * pageSize);
  return {
    rows: rows.slice(0, pageSize).map(({ first, second, ...row }) => ({
      ...row,
      names: [first.name, second.name],
    })),
    hasOlder: rows.length > pageSize,
  };
}

export async function getIntroduction(id: string) {
  await requireAdmin();
  return db().transaction(
    async (store) => {
      const [row] = await store
        .select({
          proposal: introductionProposals,
          agentName: agents.name,
          delivery: {
            status: outboundActions.status,
            providerMessageId: outboundActions.providerMessageId,
            reason: outboundActions.reason,
          },
          approval: {
            draft: actionIntents.payload,
            status: actionIntents.reviewStatus,
            expiresAt: actionIntents.reviewExpiresAt,
            note: actionIntents.reviewNote,
          },
        })
        .from(introductionProposals)
        .innerJoin(agents, eq(agents.id, introductionProposals.agentId))
        .leftJoin(
          actionIntents,
          and(
            eq(actionIntents.id, introductionProposals.reviewIntentId),
            eq(actionIntents.agentId, introductionProposals.agentId),
            inArray(actionIntents.actionType, [INTRODUCTION_REVIEW, EMAIL_INTRODUCTION_ACTION]),
          ),
        )
        .leftJoin(
          outboundActions,
          and(
            eq(outboundActions.agentId, introductionProposals.agentId),
            eq(outboundActions.intentId, introductionProposals.reviewIntentId),
            eq(outboundActions.actionType, EMAIL_INTRODUCTION_ACTION),
          ),
        )
        .where(eq(introductionProposals.id, id));
      if (!row) return null;

      const { proposal, agentName, approval, delivery } = row;
      const [decisions, valid, disclosure] = await Promise.all([
        introductionConsents(store, proposal),
        validPeopleBindings(store, proposal),
        proposal.disclosureVersion === 2 ? introductionEmailDisclosure(store, proposal) : null,
      ]);
      const parties = introductionParties(proposal).map(({ personId, name, blurb }) => {
        const consent = decisions.find(({ recipient }) => personId === recipient);
        return {
          personId,
          name,
          blurb,
          decision: consent?.introductionDecision ?? ('waiting' as const),
          evidence: consent?.evidence,
          updatedAt: consent?.updatedAt,
        };
      });

      const changed =
        decisions.some(
          (decision) =>
            decision.introductionDecision === 'agreed' &&
            decision.disclosureDigest !== disclosure?.digest,
        ) && proposal.disclosureVersion === 2;
      let status = 'Waiting for consent';
      let blockedReason: string | undefined;
      const negative = parties.find(
        ({ decision }) => decision === 'declined' || decision === 'revoked',
      );
      if (negative) {
        status = delivery?.status === 'sent' ? 'Consent revoked after send' : 'Blocked';
        blockedReason =
          negative.decision === 'revoked'
            ? 'A participant revoked consent.'
            : 'A participant declined the introduction.';
      } else if (!valid) {
        status = 'Blocked';
        blockedReason = 'A People identity or its source changed. Create a new introduction.';
      } else if (delivery) {
        status = 'Approved email';
      } else if (proposal.disclosureVersion === 2 && (!disclosure || changed)) {
        status = 'Email unavailable';
        blockedReason = changed
          ? 'The email disclosure changed. Create a new introduction and obtain fresh consent.'
          : 'Each person needs one distinct email address from this agent’s own interactions.';
      } else if (approval?.status === 'approved') {
        status = 'Approved draft';
      } else if (
        approval?.note === 'expired' ||
        (approval?.expiresAt && approval.expiresAt <= new Date())
      ) {
        status = 'Review expired';
      } else if (approval?.status === 'rejected') {
        status = 'Draft rejected';
      } else if (approval?.status === 'pending') {
        status = 'Ready for review';
      }

      return {
        id,
        agentName,
        parties,
        status,
        blockedReason,
        agentId: proposal.agentId,
        runId: proposal.runId,
        rationale: proposal.rationale,
        identitiesCurrent: valid,
        canAgree: proposal.disclosureVersion === 1 || Boolean(disclosure && !changed),
        disclosureDigest: changed ? null : disclosure?.digest,
        emailPreview:
          approval &&
          typeof approval.draft.subject === 'string' &&
          typeof approval.draft.draft === 'string' &&
          Array.isArray(approval.draft.to) &&
          approval.draft.to.every((address): address is string => typeof address === 'string')
            ? {
                subject: approval.draft.subject,
                draft: approval.draft.draft,
                to: approval.draft.to,
              }
            : changed
              ? null
              : disclosure,
        legacy: proposal.disclosureVersion === 1,
        delivery,
        reviewStatus: approval?.status,
        draft: typeof approval?.draft.draft === 'string' ? approval.draft.draft : null,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
