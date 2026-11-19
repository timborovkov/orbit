import { recipientConsents } from '@/lib/schema';
import { demoConsents } from '@/lib/seed/catalog';
import { demoTime } from '@/lib/seed/clock';
import { DEMO_ACTOR } from '@/lib/seed/ids';
import type { SeedModule } from '@/lib/seed/types';

export const consentsModule: SeedModule = {
  name: 'consents',
  async apply({ tx, now }) {
    for (const row of demoConsents()) {
      await tx
        .insert(recipientConsents)
        .values({
          agentId: row.agentId,
          recipient: row.recipient,
          scope: row.scope,
          evidence: row.evidence,
          granted: row.granted,
          updatedAt: demoTime(now, row.updatedOffsetMs),
          actor: DEMO_ACTOR,
        })
        .onConflictDoUpdate({
          target: [recipientConsents.agentId, recipientConsents.recipient, recipientConsents.scope],
          set: {
            evidence: row.evidence,
            granted: row.granted,
            updatedAt: demoTime(now, row.updatedOffsetMs),
            actor: DEMO_ACTOR,
          },
        });
    }
  },
};
