import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { Tx } from '@/lib/db';
import { type ConsentScope, consentScope } from '@/lib/policy/scopes';
import { channelAction } from '@/lib/runtime/channels/registry';
import { X_REPLY_ACTION } from '@/lib/runtime/x/reply-input';
import { recipientConsents } from '@/lib/schema';

export async function recipientConsentFailure(
  tx: Tx,
  agentId: string,
  type: string,
  recipients: string[],
  requiredTools: ConsentScope[],
) {
  const scope = consentScope.safeParse(channelAction(type)?.action.consentScope ?? type);
  if (!scope.success) return null;

  const distinct = [...new Set(recipients)];
  const expected = scope.data === 'introduce' ? 2 : 1;
  if (distinct.length !== expected) {
    return expected === 2
      ? 'An introduction requires two distinct recipients.'
      : scope.data === X_REPLY_ACTION
        ? 'An X reply requires one author.'
        : 'Escalation requires one recipient.';
  }

  const decisions = await tx
    .select({ granted: recipientConsents.granted })
    .from(recipientConsents)
    .where(
      and(
        eq(recipientConsents.agentId, agentId),
        eq(recipientConsents.scope, scope.data),
        isNull(recipientConsents.introductionId),
        inArray(recipientConsents.recipient, distinct),
      ),
    );
  if (decisions.some(({ granted }) => !granted)) {
    return 'A recipient declined or revoked consent for this action.';
  }
  if (
    (scope.data === X_REPLY_ACTION || requiredTools.includes(scope.data)) &&
    decisions.length !== expected
  ) {
    return 'Current consent is required from every recipient for this action.';
  }
  return null;
}
