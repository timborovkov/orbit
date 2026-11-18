import 'server-only';

import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import type { AgentConfig } from '@/lib/runtime/config';
import { environmentOpenRouterKey } from '@/lib/runtime/openrouter-key';
import { encryptCredential } from '@/lib/runtime/secrets';
import { agents, audit, configurations, credentials, templates } from '@/lib/schema';

// Internal mutations: callers must authenticate, validate inputs and supply the audit actor.
export async function persistConfiguration(
  actor: string,
  agentId: string,
  version: number,
  config: AgentConfig,
) {
  return await db().transaction(async (tx) => {
    await tx.select().from(agents).where(eq(agents.id, agentId)).for('update');
    const current = (
      await tx
        .select()
        .from(configurations)
        .where(eq(configurations.agentId, agentId))
        .orderBy(desc(configurations.version))
        .limit(1)
    ).at(0);
    if (current?.version !== version) return false;
    await tx
      .insert(configurations)
      .values({ agentId, version: version + 1, config: config, actor });
    await tx
      .update(agents)
      .set({ name: config.name, mission: config.mission })
      .where(eq(agents.id, agentId));
    await tx
      .insert(audit)
      .values({ actor, action: `Saved configuration v${version + 1} for ${config.name}` });
    return true;
  });
}

export async function persistTemplate(
  actor: string,
  id: string,
  revision: number,
  config: AgentConfig,
) {
  return await db().transaction(async (tx) => {
    const rows = await tx
      .update(templates)
      .set({ config: { ...config, name: '' }, revision: revision + 1 })
      .where(and(eq(templates.id, id), eq(templates.revision, revision)))
      .returning();
    if (!rows.length) return false;
    await tx.insert(audit).values({ actor, action: `Updated template ${id} defaults` });
    return true;
  });
}

export async function persistCredential(
  actor: string,
  agentId: string,
  secret: string,
  revoke: boolean,
) {
  let encryptedKey = '';
  if (!revoke) {
    try {
      encryptedKey = encryptCredential(agentId, secret);
    } catch {
      return {
        error:
          'Set ORBIT_ENCRYPTION_KEY to a 64-character hex key on the server before saving credentials.',
      };
    }
  }
  await db().transaction(async (tx) => {
    const agent = (
      await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId))
    ).at(0);
    if (revoke) await tx.delete(credentials).where(eq(credentials.agentId, agentId));
    else
      await tx
        .insert(credentials)
        .values({ agentId, encryptedKey })
        .onConflictDoUpdate({ target: credentials.agentId, set: { encryptedKey } });
    await tx.insert(audit).values({
      actor,
      action: `${revoke ? 'Revoked' : 'Replaced'} OpenRouter credential for ${agent?.name ?? 'agent'}`,
    });
  });
  if (!revoke) return { message: 'Credential saved encrypted.' };
  return {
    message: environmentOpenRouterKey()
      ? 'Credential removed. Simulations will use the environment default.'
      : 'Credential removed.',
  };
}
