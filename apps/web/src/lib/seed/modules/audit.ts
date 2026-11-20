import { audit } from '@/lib/schema';
import { demoTime } from '@/lib/seed/clock';
import { DEMO_ACTOR, DEMO_AUDIT } from '@/lib/seed/ids';
import type { SeedModule } from '@/lib/seed/types';

export const auditModule: SeedModule = {
  name: 'audit',
  async apply({ tx, now }) {
    const rows = [
      {
        id: DEMO_AUDIT.created,
        action: 'Demo seed: created John, Sarah and Maya from templates',
        createdOffsetMs: -21 * 24 * 60 * 60 * 1000,
      },
      {
        id: DEMO_AUDIT.seeded,
        action: 'Demo seed: refreshed realistic workspace fixtures',
        createdOffsetMs: -5 * 60 * 1000,
      },
    ];
    for (const row of rows) {
      await tx
        .insert(audit)
        .values({
          id: row.id,
          actor: DEMO_ACTOR,
          action: row.action,
          createdAt: demoTime(now, row.createdOffsetMs),
        })
        .onConflictDoUpdate({
          target: audit.id,
          set: {
            actor: DEMO_ACTOR,
            action: row.action,
            createdAt: demoTime(now, row.createdOffsetMs),
          },
        });
    }
  },
};
