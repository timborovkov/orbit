import 'server-only';

import { and, desc, eq } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import { identityPair, lockPeople, moveIdentity } from '@/lib/runtime/people/identity';
import {
  audit,
  emailMessages,
  people,
  personContacts,
  type PersonEvidence,
  personIdentities,
  personIdentityChanges,
  personLinkRejections,
  sourceEvents,
} from '@/lib/schema';

type Identity = typeof personIdentities.$inferSelect;
type IdentityInput = { id: string; sourceId: string; revision: number };

async function loadIdentity(tx: Tx, input: IdentityInput) {
  const [identity] = await tx
    .select()
    .from(personIdentities)
    .where(and(eq(personIdentities.id, input.id), eq(personIdentities.revision, input.revision)));
  if (!identity) return null;
  const source = identity.channel === 'email' ? emailMessages : sourceEvents;
  const [evidence] = await tx
    .select({ id: source.id })
    .from(source)
    .where(and(eq(source.id, input.sourceId), eq(source.personIdentityId, identity.id)));
  return evidence
    ? { identity, evidence: { channel: identity.channel, sourceId: evidence.id } }
    : null;
}

async function rejectFormerLinks(
  tx: Tx,
  identity: Identity,
  actor: string,
  reason: string,
  evidence: PersonEvidence,
) {
  const peers = await tx
    .select()
    .from(personIdentities)
    .where(eq(personIdentities.personId, identity.personId))
    .then((rows) => rows.filter(({ id }) => id !== identity.id));
  if (peers.length) {
    await tx
      .insert(personLinkRejections)
      .values(peers.map(({ id }) => identityPair(identity.id, id)))
      .onConflictDoNothing();
  }
  await Promise.all(
    peers
      .filter((peer) => peer.linkState === 'inferred' && peer.linkedViaId === identity.id)
      .map((peer) =>
        moveIdentity(tx, peer, null, { action: 'rollback', actor, reason, evidence: [evidence] }),
      ),
  );
}

export async function savePersonLink(
  actor: string,
  input: { identity: IdentityInput; target: IdentityInput; reason: string },
) {
  return await db().transaction(async (tx) => {
    await lockPeople(tx);
    const from = await loadIdentity(tx, input.identity);
    const to = await loadIdentity(tx, input.target);
    if (!from || !to)
      return { error: 'An identity or its evidence changed. Reload and try again.' };
    if (from.identity.id === to.identity.id) return { error: 'Choose two different identities.' };
    const sameRecord = from.identity.personId === to.identity.personId;
    if (
      sameRecord &&
      (from.identity.linkState !== 'inferred' || from.identity.linkedViaId !== to.identity.id)
    ) {
      return { error: 'These identities are already on the same person.' };
    }
    if (!sameRecord) await rejectFormerLinks(tx, from.identity, actor, input.reason, from.evidence);
    const pair = identityPair(from.identity.id, to.identity.id);
    await tx
      .delete(personLinkRejections)
      .where(
        and(
          eq(personLinkRejections.firstIdentityId, pair.firstIdentityId),
          eq(personLinkRejections.secondIdentityId, pair.secondIdentityId),
        ),
      );
    await moveIdentity(
      tx,
      from.identity,
      { personId: to.identity.personId, via: to.identity.id },
      {
        action: 'confirm',
        actor,
        reason: input.reason,
        evidence: [from.evidence, to.evidence],
      },
    );
    return { message: 'Identity linked.' };
  });
}

export async function removePersonLink(
  actor: string,
  input: { identity: IdentityInput; reason: string },
) {
  return await db().transaction(async (tx) => {
    await lockPeople(tx);
    const from = await loadIdentity(tx, input.identity);
    if (!from || from.identity.linkState === 'standalone') {
      return { error: 'The link changed. Reload and try again.' };
    }
    await rejectFormerLinks(tx, from.identity, actor, input.reason, from.evidence);
    const [previous] = await tx
      .select({ evidence: personIdentityChanges.evidence })
      .from(personIdentityChanges)
      .where(
        and(
          eq(personIdentityChanges.identityId, from.identity.id),
          eq(personIdentityChanges.toPersonId, from.identity.personId),
        ),
      )
      .orderBy(desc(personIdentityChanges.createdAt), desc(personIdentityChanges.id))
      .limit(1);
    await moveIdentity(tx, from.identity, null, {
      action: 'unlink',
      actor,
      reason: input.reason,
      evidence: previous?.evidence ?? [from.evidence],
    });
    return { message: 'Identity unlinked.' };
  });
}

export async function savePersonContact(
  actor: string,
  input: {
    personId: string;
    kind: 'phone' | 'instagram';
    label: string;
    providerAccountId: string | null;
  },
) {
  return await db().transaction(async (tx) => {
    await lockPeople(tx);
    const [person] = await tx
      .select({ id: people.id })
      .from(people)
      .where(eq(people.id, input.personId));
    if (!person) return { error: 'Person not found.' };
    const [contact] = await tx
      .insert(personContacts)
      .values(input)
      .onConflictDoNothing()
      .returning({ id: personContacts.id });
    if (!contact) return { error: 'This contact method was already recorded.' };
    await tx.insert(audit).values({ actor, action: 'people.contact.add' });
    return { message: 'Contact added.' };
  });
}

export async function removePersonContact(actor: string, personId: string, contactId: string) {
  return await db().transaction(async (tx) => {
    await lockPeople(tx);
    const [contact] = await tx
      .delete(personContacts)
      .where(and(eq(personContacts.id, contactId), eq(personContacts.personId, personId)))
      .returning({ id: personContacts.id });
    if (!contact) return { error: 'Contact not found.' };
    await tx.insert(audit).values({ actor, action: 'people.contact.remove' });
    return { message: 'Contact removed.' };
  });
}
