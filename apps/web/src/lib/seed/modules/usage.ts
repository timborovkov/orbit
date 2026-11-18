import { usageCounters } from '@/lib/schema';
import { demoUsage } from '@/lib/seed/catalog';
import type { SeedModule } from '@/lib/seed/types';

export const usageModule: SeedModule = {
  name: 'usage',
  async apply({ tx, now }) {
    await Promise.all(
      demoUsage(now).map((row) =>
        tx
          .insert(usageCounters)
          .values({
            agentId: row.agentId,
            period: row.period,
            periodStart: row.periodStart,
            spendMicros: row.spendMicros,
            requests: row.requests,
            outboundActions: row.outboundActions,
          })
          .onConflictDoUpdate({
            target: [usageCounters.agentId, usageCounters.period, usageCounters.periodStart],
            set: {
              spendMicros: row.spendMicros,
              requests: row.requests,
              outboundActions: row.outboundActions,
            },
          }),
      ),
    );
  },
};
