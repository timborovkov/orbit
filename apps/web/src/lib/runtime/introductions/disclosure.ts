import { and, eq } from 'drizzle-orm';

import type { Db, Tx } from '@/lib/db';
import { observedProfiles } from '@/lib/runtime/introductions/profiles';
import { INTRODUCTION_REVIEW } from '@/lib/runtime/introductions/types';
import { lockPeople } from '@/lib/runtime/people/identity';
import { type actionIntents, introductionProposals, recipientConsents } from '@/lib/schema';

type Proposal = typeof introductionProposals.$inferSelect;
type Intent = typeof actionIntents.$inferSelect;

export function introductionParties(proposal: Proposal) {
  return [
    { ...proposal.firstDisclosure, personId: proposal.firstPersonId },
    { ...proposal.secondDisclosure, personId: proposal.secondPersonId },
  ] as const;
}

export function introductionDraft(proposal: Proposal) {
  const [first, second] = introductionParties(proposal);
  return [
    `Hello ${first.name} and ${second.name},`,
    '',
    `I'd like to introduce you to each other.`,
    '',
    `${first.name} — ${first.blurb}`,
    `${second.name} — ${second.blurb}`,
  ].join('\n');
}

export async function introductionConsents(store: Db | Tx, proposal: Proposal) {
  return store
    .select()
    .from(recipientConsents)
    .where(
      and(
        eq(recipientConsents.agentId, proposal.agentId),
        eq(recipientConsents.introductionId, proposal.id),
      ),
    );
}

export async function validPeopleBindings(store: Db | Tx, proposal: Proposal) {
  const parties = introductionParties(proposal);
  const current = await observedProfiles(store, proposal.agentId, {
    personIds: parties.map(({ personId }) => personId),
    sourceIds: parties.map(({ sourceId }) => sourceId),
  });
  return parties.every((party) =>
    current.some(
      (profile) =>
        profile.personId === party.personId &&
        profile.identityId === party.identityId &&
        profile.identityRevision === party.identityRevision &&
        profile.sourceKind === party.sourceKind &&
        profile.sourceId === party.sourceId &&
        profile.name === party.name,
    ),
  );
}

export function hasBothAgreements(
  proposal: Proposal,
  decisions: Awaited<ReturnType<typeof introductionConsents>>,
) {
  return introductionParties(proposal).every(({ personId }) =>
    decisions.some(
      ({ recipient, introductionDecision }) =>
        recipient === personId && introductionDecision === 'agreed',
    ),
  );
}

function matchesRecipients(proposal: Proposal, recipients: string[]) {
  return (
    recipients.length === 2 &&
    recipients.includes(proposal.firstPersonId) &&
    recipients.includes(proposal.secondPersonId)
  );
}

/** Validate a legacy review-only draft while holding the agent lock. */
export async function introductionDisclosureFailure(tx: Tx, intent: Intent) {
  if (intent.actionType !== INTRODUCTION_REVIEW) return null;
  await lockPeople(tx);
  const [proposal] = await tx
    .select()
    .from(introductionProposals)
    .where(
      and(
        eq(introductionProposals.reviewIntentId, intent.id),
        eq(introductionProposals.agentId, intent.agentId),
      ),
    );
  if (!proposal || !matchesRecipients(proposal, intent.recipients)) {
    return 'The introduction recipients do not match the proposal.';
  }
  const draft = introductionDraft(proposal);
  if (intent.payload.introductionId !== proposal.id || intent.payload.draft !== draft) {
    return 'The introduction draft or recipients changed after consent.';
  }
  if (!hasBothAgreements(proposal, await introductionConsents(tx, proposal))) {
    return 'Both people must currently agree to this introduction.';
  }
  if (!(await validPeopleBindings(tx, proposal))) {
    return 'A People identity or its source changed. Create a new introduction.';
  }
  return null;
}
