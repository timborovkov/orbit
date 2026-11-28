import { createHash } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db, Tx } from '@/lib/db';
import type { ActionIntent, OutboundRow } from '@/lib/runtime/channels/types';
import { extractEmailAddress, sendingDomainMatches } from '@/lib/runtime/email/headers';
import { sendingEmailDomain } from '@/lib/runtime/email/settings';
import { createResendTransport, type EmailTransport } from '@/lib/runtime/email/transport';
import {
  introductionConsents,
  introductionDraft,
  introductionParties,
  validPeopleBindings,
} from '@/lib/runtime/introductions/disclosure';
import { lockPeople } from '@/lib/runtime/people/identity';
import {
  emailMailboxes,
  emailMessages,
  introductionProposals,
  personIdentities,
} from '@/lib/schema';

type Proposal = typeof introductionProposals.$inferSelect;
const emailAddress = z.email();

export async function introductionEmailDisclosure(store: Db | Tx, proposal: Proposal) {
  const parties = introductionParties(proposal);
  const evidence = await store
    .selectDistinct({
      personId: personIdentities.personId,
      identityId: personIdentities.id,
      revision: personIdentities.revision,
      address: personIdentities.identityKey,
    })
    .from(personIdentities)
    .innerJoin(emailMessages, eq(emailMessages.personIdentityId, personIdentities.id))
    .where(
      and(
        eq(personIdentities.channel, 'email'),
        eq(emailMessages.agentId, proposal.agentId),
        eq(personIdentities.identityKey, sql`person_email_key(${emailMessages.sender})`),
        inArray(
          personIdentities.personId,
          parties.map(({ personId }) => personId),
        ),
      ),
    );
  const bindings = parties.map(({ personId }) =>
    evidence.filter((row) => row.personId === personId),
  );
  const [[first], [second]] = bindings;
  if (
    bindings.some((matches) => matches.length !== 1) ||
    !first ||
    !second ||
    first.address === second.address ||
    [first, second].some(({ address }) => !emailAddress.safeParse(address).success)
  )
    return null;

  const payload = {
    introductionId: proposal.id,
    subject: `Introduction: ${parties[0].name} and ${parties[1].name}`,
    draft: introductionDraft(proposal),
    to: [first.address, second.address],
  };
  const digest = createHash('sha256')
    .update(JSON.stringify({ payload, parties, bindings }))
    .digest('hex');
  return { ...payload, digest };
}

async function validatedIntroduction(tx: Tx, intent: ActionIntent) {
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
  if (!proposal || proposal.disclosureVersion !== 2) {
    return { error: 'Email introductions require fresh consent to the email disclosure.' };
  }
  if (!(await validPeopleBindings(tx, proposal))) {
    return { error: 'A People identity or its source changed. Create a new introduction.' };
  }
  const disclosure = await introductionEmailDisclosure(tx, proposal);
  if (
    !disclosure ||
    intent.payload.introductionId !== proposal.id ||
    intent.payload.subject !== disclosure.subject ||
    intent.payload.draft !== disclosure.draft ||
    intent.payload.digest !== disclosure.digest ||
    JSON.stringify(intent.payload.to) !== JSON.stringify(disclosure.to) ||
    JSON.stringify(intent.recipients) !== JSON.stringify(disclosure.to)
  ) {
    return { error: 'The introduction draft or addresses changed. Create a new introduction.' };
  }
  const decisions = await introductionConsents(tx, proposal);
  if (
    !introductionParties(proposal).every(({ personId }) =>
      decisions.some(
        (decision) =>
          decision.recipient === personId &&
          decision.scope === 'introduce' &&
          decision.granted &&
          decision.introductionDecision === 'agreed' &&
          decision.disclosureDigest === disclosure.digest,
      ),
    )
  ) {
    return { error: 'Both people must currently agree to the exact email disclosure.' };
  }
  return { disclosure };
}

async function introductionMailbox(tx: Tx, agentId: string) {
  const [mailbox] = await tx
    .select()
    .from(emailMailboxes)
    .where(eq(emailMailboxes.agentId, agentId))
    .for('update');
  return mailbox?.enabled ? mailbox : null;
}

export async function validateIntroductionApproval(tx: Tx, intent: ActionIntent) {
  const result = await validatedIntroduction(tx, intent);
  if (result.error) return result.error;
  if (!(await introductionMailbox(tx, intent.agentId))) {
    return 'Enable the agent mailbox before approving an email introduction.';
  }
}

export async function prepareIntroductionDelivery(
  tx: Tx,
  outbound: OutboundRow,
  intent: ActionIntent,
  transport?: EmailTransport,
  configuredDomain = process.env.RESEND_SENDING_DOMAIN,
) {
  const result = await validatedIntroduction(tx, intent);
  if (result.error !== undefined) return { error: result.error };
  const { disclosure } = result;
  if (outbound.body !== disclosure.draft || outbound.idempotencyKey !== intent.idempotencyKey) {
    return { error: 'The queued email differs from the approved introduction.' };
  }
  const mailbox = await introductionMailbox(tx, intent.agentId);
  if (!mailbox) return { error: 'Agent mailbox is disabled.' };
  const domain = sendingEmailDomain(configuredDomain);
  if (
    !emailAddress.safeParse(mailbox.address).success ||
    extractEmailAddress(mailbox.address) !== mailbox.address ||
    (Boolean(configuredDomain?.trim()) && !domain) ||
    !sendingDomainMatches(mailbox.address, domain)
  )
    return { error: 'Mailbox address is not on the configured sending domain.' };

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const activeTransport = transport ?? (apiKey ? createResendTransport(apiKey) : null);
  if (!activeTransport) return { error: 'Resend API key is not configured on the worker.' };
  return {
    recipients: disclosure.to,
    send: (signal: AbortSignal) =>
      activeTransport.send(
        {
          from: mailbox.address,
          to: disclosure.to,
          subject: disclosure.subject,
          text: disclosure.draft,
          headers: {},
          idempotencyKey: outbound.idempotencyKey,
        },
        signal,
      ),
  };
}
