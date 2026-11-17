import 'server-only';

import { asc, desc, eq } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { openRouterKeySource } from '@/lib/runtime/openrouter-key';
import {
  agents,
  audit,
  configurations,
  controls,
  credentials,
  runs,
  templates,
} from '@/lib/schema';

export async function getOverview() {
  const email = await requireAdmin();
  const [team, events, state, presets] = await Promise.all([
    db().select().from(agents).orderBy(desc(agents.createdAt)),
    db().select().from(audit).orderBy(desc(audit.createdAt)).limit(12),
    db().select().from(controls),
    db().select().from(templates),
  ]);
  return { email, team, events, state, presets };
}
export async function getTemplates() {
  const email = await requireAdmin();
  const items = await db().select().from(templates).orderBy(asc(templates.title));
  return { email, items };
}
export async function getAgentPictureKey(id: string) {
  await requireAdmin();
  return (
    (await db().select({ key: agents.pictureKey }).from(agents).where(eq(agents.id, id))).at(0)
      ?.key ?? null
  );
}
export async function getAgentWorkspace(id: string) {
  await requireAdmin();
  const agent = (await db().select().from(agents).where(eq(agents.id, id))).at(0);
  if (!agent) return null;
  const [versions, keys, history] = await Promise.all([
    db()
      .select()
      .from(configurations)
      .where(eq(configurations.agentId, id))
      .orderBy(desc(configurations.version)),
    db()
      .select({ agentId: credentials.agentId })
      .from(credentials)
      .where(eq(credentials.agentId, id)),
    db().select().from(runs).where(eq(runs.agentId, id)).orderBy(desc(runs.createdAt)).limit(50),
  ]);
  const current = versions.at(0);
  if (!current) return null;
  const viewedHistory = history.map((run) => ({
    ...run,
    interrupted: run.status === 'running' && run.expiresAt < new Date(),
  }));
  const hasAgentCredential = keys.length > 0;
  return {
    agent,
    versions,
    hasAgentCredential,
    keySource: openRouterKeySource(hasAgentCredential),
    history: viewedHistory,
    current,
  };
}
