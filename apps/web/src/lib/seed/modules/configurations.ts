import { configurations } from '@/lib/schema';
import { demoConfigurations } from '@/lib/seed/catalog';
import { demoTime } from '@/lib/seed/clock';
import { DEMO_ACTOR } from '@/lib/seed/ids';
import type { SeedModule } from '@/lib/seed/types';

export const configurationsModule: SeedModule = {
  name: 'configurations',
  async apply({ tx, now }) {
    for (const row of demoConfigurations()) {
      await tx
        .insert(configurations)
        .values({
          id: row.id,
          agentId: row.agentId,
          version: row.version,
          config: row.config,
          actor: DEMO_ACTOR,
          createdAt: demoTime(now, row.createdOffsetMs),
        })
        .onConflictDoUpdate({
          target: configurations.id,
          set: {
            agentId: row.agentId,
            version: row.version,
            config: row.config,
            actor: DEMO_ACTOR,
            createdAt: demoTime(now, row.createdOffsetMs),
          },
        });
    }
  },
};
