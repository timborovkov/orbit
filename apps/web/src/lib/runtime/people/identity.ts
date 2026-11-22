import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';

import type { Tx } from '@/lib/db';
import { extractEmailAddress } from '@/lib/runtime/email/headers';
import { X_PROVIDER } from '@/lib/runtime/x/types';
import {
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
type LinkChange = typeof personIdentityChanges.$inferInsert;
type Claim = { identityId: string; sourceId: string; claim: string; observedAt: Date };
type XClaim = Claim & { handle: string };
const claimWindowMs = 30 * 24 * 60 * 60 * 1000;
const reconciliationActor = 'system:people';
const xObservedAt =
  sql<Date>`coalesce(${sourceEvents.providerCreatedAt}, ${sourceEvents.ingestedAt})`.mapWith(
    sourceEvents.ingestedAt,
  );

export function emailXClaim(body: string): string | null {
  const original = body.split(
    /^\s*(?:On .* wrote:|[- ]*Original Message[- ]*|[- ]*Forwarded message[- ]*)\s*$/im,
  )[0];
  const claims = new Set<string>();
  for (const line of original.split(/\r?\n/)) {
    const handle =
      /^(?:My X account:\s*|Find me on X at\s+)(?:@|https:\/\/x\.com\/)([a-z0-9_]{1,15})\.?$/i.exec(
        line.trim(),
      )?.[1] ?? /^(?:I['’]m|I am) @([a-z0-9_]{1,15}) on X\.?$/i.exec(line.trim())?.[1];
    if (handle) claims.add(handle.toLowerCase());
  }
  return claims.size === 1 ? [...claims][0] : null;
}

export function xEmailClaim(text: string): string | null {
  if (/^\s*RT\s+@/i.test(text)) return null;
  const claims = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const address = /^(?:My email:\s*|My email is\s+|You can reach me at\s+)([^\s<>]+)$/i.exec(
      line.trim(),
    )?.[1];
    const normalized = address && extractEmailAddress(address.replace(/[.!]$/, ''));
    if (normalized) claims.add(normalized);
  }
  return claims.size === 1 ? [...claims][0] : null;
}

export async function observedClaimedHandle(tx: Tx, handles: string[]) {
  if (!handles.length) return false;
  const [claim] = await tx
    .select({ id: emailMessages.id })
    .from(emailMessages)
    .where(inArray(emailMessages.personClaim, handles))
    .limit(1);
  return Boolean(claim);
}

async function competingObservation(tx: Tx, x: XClaim) {
  const [conflicting] = await tx
    .select({ id: sourceEvents.id })
    .from(sourceEvents)
    .where(
      and(
        eq(sourceEvents.provider, X_PROVIDER),
        eq(sql`lower(${sourceEvents.authorUsername})`, x.handle),
        ne(sourceEvents.personIdentityId, x.identityId),
        sql`${xObservedAt} >= ${new Date(x.observedAt.getTime() - claimWindowMs).toISOString()}::timestamptz`,
        sql`${xObservedAt} <= ${new Date(x.observedAt.getTime() + claimWindowMs).toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(xObservedAt), asc(sourceEvents.id))
    .limit(1);
  return conflicting?.id;
}

export async function lockPeople(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock(712605)`);
}

export function identityPair(left: string, right: string) {
  return left < right
    ? { firstIdentityId: left, secondIdentityId: right }
    : { firstIdentityId: right, secondIdentityId: left };
}

export async function moveIdentity(
  tx: Tx,
  identity: Identity,
  destination: { personId: string; via: string } | null,
  change: Pick<LinkChange, 'action' | 'actor' | 'reason' | 'evidence'>,
) {
  let homePersonId = identity.homePersonId;
  if (!destination) {
    const occupants = await tx
      .select({ id: personIdentities.id })
      .from(personIdentities)
      .where(eq(personIdentities.personId, homePersonId));
    if (occupants.some(({ id }) => id !== identity.id)) {
      const [home] = await tx.insert(people).values({}).returning({ id: people.id });
      homePersonId = home.id;
    }
  }
  const personId = destination?.personId ?? homePersonId;
  await tx
    .update(personIdentities)
    .set({
      personId,
      homePersonId,
      linkedViaId: destination?.via ?? null,
      linkState: !destination ? 'standalone' : change.action === 'infer' ? 'inferred' : 'confirmed',
      revision: identity.revision + 1,
    })
    .where(eq(personIdentities.id, identity.id));
  await tx.insert(personIdentityChanges).values({
    ...change,
    identityId: identity.id,
    fromPersonId: identity.personId,
    toPersonId: personId,
  });
}

function pairEvidence(email: Claim | undefined, x: Claim | undefined): PersonEvidence[] {
  const evidence: PersonEvidence[] = [];
  if (email) evidence.push({ channel: 'email', sourceId: email.sourceId });
  if (x) evidence.push({ channel: 'x', sourceId: x.sourceId });
  return evidence;
}

/** Provider records own the claims. Reconciliation never relies on model output. */
export async function reconcilePeople(tx: Tx) {
  await lockPeople(tx);
  const [emailRows, xRows, identities] = await Promise.all([
    tx
      .selectDistinctOn([emailMessages.personIdentityId], {
        identityId: emailMessages.personIdentityId,
        sourceId: emailMessages.id,
        claim: emailMessages.personClaim,
        observedAt: emailMessages.receivedAt,
      })
      .from(emailMessages)
      .where(and(isNotNull(emailMessages.personIdentityId), isNotNull(emailMessages.personClaim)))
      .orderBy(
        asc(emailMessages.personIdentityId),
        desc(emailMessages.receivedAt),
        desc(emailMessages.id),
      ),
    tx
      .selectDistinctOn([sourceEvents.personIdentityId], {
        identityId: sourceEvents.personIdentityId,
        sourceId: sourceEvents.id,
        claim: sourceEvents.personClaim,
        handle: sourceEvents.authorUsername,
        observedAt: xObservedAt,
      })
      .from(sourceEvents)
      .where(
        and(
          eq(sourceEvents.provider, X_PROVIDER),
          isNotNull(sourceEvents.personIdentityId),
          isNotNull(sourceEvents.personClaim),
        ),
      )
      .orderBy(asc(sourceEvents.personIdentityId), desc(xObservedAt), desc(sourceEvents.id)),
    tx.select().from(personIdentities),
  ]);
  const emailClaims = new Map<string, Claim>();
  for (const row of emailRows) {
    if (row.identityId && row.claim) {
      emailClaims.set(row.identityId, { ...row, identityId: row.identityId, claim: row.claim });
    }
  }
  const xClaims = new Map<string, XClaim>();
  for (const row of xRows) {
    if (row.identityId && row.claim && row.handle) {
      xClaims.set(row.identityId, {
        ...row,
        identityId: row.identityId,
        claim: row.claim,
        handle: row.handle.toLowerCase(),
      });
    }
  }
  const byId = new Map(identities.map((identity) => [identity.id, identity]));
  const byEmail = new Map(
    identities
      .filter(({ channel }) => channel === 'email')
      .map((identity) => [identity.identityKey, identity]),
  );
  const reciprocal = new Map<string, XClaim[]>();
  for (const x of xClaims.values()) {
    const email = byEmail.get(x.claim);
    if (email && emailClaims.get(email.id)?.claim === x.handle) {
      const matches = reciprocal.get(email.id) ?? [];
      matches.push(x);
      reciprocal.set(email.id, matches);
    }
  }

  const inferred = identities.filter(
    ({ channel, linkState }) => channel === X_PROVIDER && linkState === 'inferred',
  );
  const inferences = inferred.length
    ? await tx
        .selectDistinctOn([personIdentityChanges.identityId], {
          identityId: personIdentityChanges.identityId,
          evidence: personIdentityChanges.evidence,
        })
        .from(personIdentityChanges)
        .where(
          and(
            eq(personIdentityChanges.action, 'infer'),
            inArray(
              personIdentityChanges.identityId,
              inferred.map(({ id }) => id),
            ),
          ),
        )
        .orderBy(
          asc(personIdentityChanges.identityId),
          desc(personIdentityChanges.createdAt),
          desc(personIdentityChanges.id),
        )
    : [];
  const originalSourceByIdentity = new Map<string, string>();
  for (const inference of inferences) {
    const source = inference.evidence.find(({ channel }) => channel === 'x');
    if (source) originalSourceByIdentity.set(inference.identityId, source.sourceId);
  }
  const sourceIds = [...originalSourceByIdentity.values()];
  const originalPosts = sourceIds.length
    ? await tx
        .select({
          sourceId: sourceEvents.id,
          handle: sourceEvents.authorUsername,
          observedAt: xObservedAt,
        })
        .from(sourceEvents)
        .where(and(eq(sourceEvents.provider, X_PROVIDER), inArray(sourceEvents.id, sourceIds)))
    : [];
  const originalBySource = new Map(originalPosts.map((row) => [row.sourceId, row]));

  // A renamed account retains its stable identity. Roll back only on changed,
  // ambiguous, or missing evidence.

  await Promise.all(
    inferred.map(async (identity) => {
      if (!identity.linkedViaId) return;
      const email = byId.get(identity.linkedViaId);
      const x = xClaims.get(identity.id);
      const emailClaim = emailClaims.get(identity.linkedViaId);
      const originalSourceId = originalSourceByIdentity.get(identity.id);
      const original = originalSourceId ? originalBySource.get(originalSourceId) : undefined;
      const originalHandle = original?.handle?.toLowerCase();
      const accepted =
        x && emailClaim?.claim === x.handle
          ? x
          : x && original && originalHandle && emailClaim?.claim === originalHandle
            ? {
                ...x,
                ...original,
                handle: originalHandle,
              }
            : null;
      const conflict = accepted ? await competingObservation(tx, accepted) : undefined;
      if (
        email?.personId === identity.personId &&
        x?.claim === email.identityKey &&
        accepted &&
        !conflict
      )
        return;
      await moveIdentity(tx, identity, null, {
        action: 'rollback',
        actor: reconciliationActor,
        reason: 'The reciprocal identity claims changed or became ambiguous.',
        evidence: [
          ...pairEvidence(emailClaim, x),
          ...(conflict ? [{ channel: 'x' as const, sourceId: conflict }] : []),
        ],
      });
    }),
  );

  const [current, contacts, rejectedPairs] = await Promise.all([
    tx.select().from(personIdentities),
    tx.selectDistinct({ personId: personContacts.personId }).from(personContacts),
    tx.select().from(personLinkRejections),
  ]);
  const currentById = new Map(current.map((identity) => [identity.id, identity]));
  const byPerson = new Map<string, string[]>();
  for (const { id, personId } of current) {
    const peers = byPerson.get(personId) ?? [];
    peers.push(id);
    byPerson.set(personId, peers);
  }
  const contactOwners = new Set(contacts.map(({ personId }) => personId));
  const rejections = new Set(
    rejectedPairs.map(
      ({ firstIdentityId, secondIdentityId }) => `${firstIdentityId}:${secondIdentityId}`,
    ),
  );

  await Promise.all(
    [...reciprocal].map(async ([emailId, candidates]) => {
      const emailClaim = emailClaims.get(emailId);
      if (!emailClaim) return;
      const recent = candidates.filter(
        (claim) =>
          Math.abs(emailClaim.observedAt.getTime() - claim.observedAt.getTime()) <= claimWindowMs,
      );
      if (recent.length !== 1) return;
      const [x] = recent;
      const email = currentById.get(emailId);
      const identity = currentById.get(x.identityId);
      if (!email || !identity || email.personId === identity.personId) return;
      if (
        identity.linkState !== 'standalone' ||
        byPerson.get(identity.personId)?.length !== 1 ||
        contactOwners.has(identity.personId)
      )
        return;
      const rejected = byPerson.get(email.personId)?.some((peerId) => {
        const { firstIdentityId, secondIdentityId } = identityPair(peerId, identity.id);
        return rejections.has(`${firstIdentityId}:${secondIdentityId}`);
      });
      if (rejected || (await competingObservation(tx, x))) return;
      await moveIdentity(
        tx,
        identity,
        { personId: email.personId, via: email.id },
        {
          action: 'infer',
          actor: reconciliationActor,
          reason: 'The email sender and X author identified each other.',
          evidence: pairEvidence(emailClaim, x),
        },
      );
    }),
  );
}
