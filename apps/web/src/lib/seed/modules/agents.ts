import { agents } from '@/lib/schema';
import { demoAgents } from '@/lib/seed/catalog';
import { demoTime } from '@/lib/seed/clock';
import type { SeedModule } from '@/lib/seed/types';

export const agentsModule: SeedModule = {
  name: 'agents',
  async apply({ tx, now }) {
    await Promise.all(
      demoAgents().map((agent) =>
        tx
          .insert(agents)
          .values({
            id: agent.id,
            name: agent.name,
            mission: agent.mission,
            lifecycle: agent.lifecycle,
            budgets: agent.budgets,
            approvalTools: agent.approvalTools,
            enabledTools: agent.enabledTools,
            pictureKey: null,
            createdAt: demoTime(now, -21 * 24 * 60 * 60 * 1000),
          })
          .onConflictDoUpdate({
            target: agents.id,
            set: {
              name: agent.name,
              mission: agent.mission,
              lifecycle: agent.lifecycle,
              budgets: agent.budgets,
              approvalTools: agent.approvalTools,
              enabledTools: agent.enabledTools,
              pictureKey: null,
            },
          }),
      ),
    );
  },
};
