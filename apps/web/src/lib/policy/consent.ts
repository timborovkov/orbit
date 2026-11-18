import { and, eq, inArray } from 'drizzle-orm';

import type { Tx } from '@/lib/db';
import { consentScope } from '@/lib/policy/scopes';
import { recipientConsents } from '@/lib/schema';

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
