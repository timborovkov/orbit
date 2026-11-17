import { and, eq, inArray } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import { consentScope, type ConsentScope } from '@/lib/policy/scopes';
import { agents, audit, recipientConsents } from '@/lib/schema';

export async function missingRecipientConsent(
  tx: Tx,
  agentId: string,
  type: string,
  recipients: string[],
) {
  const scope = consentScope.safeParse(type);
  if (!scope.success) return null;

  const distinct = [...new Set(recipients)];
  const expected = scope.data === 'introduce' ? 2 : 1;
  if (distinct.length !== expected) {
    return expected === 2
      ? 'An introduction requires two distinct recipients.'
      : 'Escalation requires one recipient.';
  }

  const grants = await tx
    .select({ recipient: recipientConsents.recipient })
    .from(recipientConsents)
    .where(
      and(
        eq(recipientConsents.agentId, agentId),
        eq(recipientConsents.scope, scope.data),
        eq(recipientConsents.granted, true),
        inArray(recipientConsents.recipient, distinct),
      ),
    );
  return grants.length === expected
    ? null
    : 'Current consent is required from every recipient for this action.';
}

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
