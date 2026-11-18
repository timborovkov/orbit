import 'server-only';

import { eq } from 'drizzle-orm';

import { reviewProposedAction, reviewProposedActionsBulk } from '@/lib/approvals/review';
import { db } from '@/lib/db';
import type { ConsentScope } from '@/lib/policy/scopes';
import { agents, audit, recipientConsents } from '@/lib/schema';

export { reviewProposedAction, reviewProposedActionsBulk };

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
      await tx
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.id, agentId))
        .for('update')
    ).at(0);
    if (!agent) return { error: 'Agent not found.' };
    await tx
      .insert(recipientConsents)
      .values(input)
      .onConflictDoUpdate({
        target: [recipientConsents.agentId, recipientConsents.recipient, recipientConsents.scope],
        set: { granted, evidence, actor, updatedAt: new Date() },
      });
    await tx.insert(audit).values({
      actor,
      action: `${granted ? 'Granted' : 'Revoked'} ${scope} consent for ${agent.name}`,
    });
    return { message: granted ? 'Consent recorded.' : 'Consent revoked.' };
  });
}
