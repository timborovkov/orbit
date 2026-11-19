import 'server-only';

import { eq } from 'drizzle-orm';

import { budgetDefaults } from '@/lib/budgets';
import { db } from '@/lib/db';
import { canAcceptBackgroundWork } from '@/lib/lifecycle';
import { configSchema } from '@/lib/runtime/config';
import { ensureDiscoveryPollJob } from '@/lib/runtime/x/poll';
import { agents, audit, configurations, templates } from '@/lib/schema';

export async function createAgentFromTemplate(
  actor: string,
  templateId: string,
  data: { name: string; mission: string },
) {
  const template = (await db().select().from(templates).where(eq(templates.id, templateId))).at(0);
  if (!template) return { ok: false as const, errors: { name: ['Choose an available template.'] } };
  const config = configSchema.parse({ ...template.config, ...data });
  await db().transaction(async (tx) => {
    const agent = (
      await tx
        .insert(agents)
        .values({ ...data, lifecycle: 'shadow', budgets: budgetDefaults, enabledTools: [] })
        .returning()
    ).at(0);
    if (!agent) throw new Error('Agent insert failed');
    await tx.insert(configurations).values({
      agentId: agent.id,
      version: 1,
      actor,
      config,
      approvalSettings: {
        approvalTools: [],
        approvalExpiresAfterHours: null,
        approvalOnReject: 'continue',
        approvalSpendCents: null,
      },
    });
    await tx.insert(audit).values({
      actor,
      action: `Created shadow agent: ${data.name}`,
    });
    if (config.xSearchQuery.trim() && canAcceptBackgroundWork(agent.lifecycle)) {
      await ensureDiscoveryPollJob(agent.id, tx);
    }
  });
  return { ok: true as const };
}
