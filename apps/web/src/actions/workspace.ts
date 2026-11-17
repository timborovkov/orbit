'use server';

import { revalidatePath } from 'next/cache';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { configSchema } from '@/lib/runtime/config';
import { executeSimulation } from '@/lib/runtime/execute';
import { encryptCredential } from '@/lib/runtime/secrets';
import { agents, audit, configurations, credentials, templates } from '@/lib/schema';

const uuid = z.uuid();
export async function saveConfiguration(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const parsed = configSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success)
    return {
      error: 'Check the name, text lengths and model IDs. Models must use provider/model format.',
    };
  const agentId = uuid.parse(form.get('agentId'));
  const version = z.coerce.number().int().positive().parse(form.get('version'));
  const saved = await db().transaction(async (tx) => {
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
      .values({ agentId, version: version + 1, config: parsed.data, actor });
    await tx
      .update(agents)
      .set({ name: parsed.data.name, mission: parsed.data.mission })
      .where(eq(agents.id, agentId));
    await tx
      .insert(audit)
      .values({ actor, action: `Saved configuration v${version + 1} for agent ${agentId}` });
    return true;
  });
  if (!saved) return { error: 'This configuration changed in another tab. Reload before saving.' };
  revalidatePath('/');
  revalidatePath(`/agents/${agentId}`);
  return { message: `Saved configuration v${version + 1}.` };
}
export async function saveTemplate(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  // Template name is supplied when creating an agent, not inherited.
  const parsed = configSchema.safeParse({ ...Object.fromEntries(form), name: 'New agent' });
  if (!parsed.success) return { error: 'Check text lengths and model IDs.' };
  const id = z.string().max(80).parse(form.get('templateId'));
  const revision = z.coerce.number().int().positive().parse(form.get('revision'));
  const saved = await db().transaction(async (tx) => {
    const rows = await tx
      .update(templates)
      .set({ config: { ...parsed.data, name: '' }, revision: revision + 1 })
      .where(and(eq(templates.id, id), eq(templates.revision, revision)))
      .returning();
    if (!rows.length) return false;
    await tx.insert(audit).values({ actor, action: `Updated template ${id} defaults` });
    return true;
  });
  if (!saved) return { error: 'Template changed in another tab. Reload before saving.' };
  revalidatePath('/templates');
  revalidatePath('/');
  return { message: 'Template defaults saved. Existing agents are unchanged.' };
}
export async function saveCredential(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const agentId = uuid.parse(form.get('agentId'));
  const secret = z.string().trim().max(512).safeParse(form.get('credential'));
  const revoke = form.get('revoke') === 'true';
  if (!revoke && (!secret.success || !secret.data || /\s/.test(secret.data)))
    return { error: 'Enter an OpenRouter API key without spaces.' };
  let encryptedKey = '';
  if (!revoke) {
    try {
      encryptedKey = encryptCredential(agentId, secret.success ? secret.data : '');
    } catch {
      return {
        error:
          'Set ORBIT_ENCRYPTION_KEY to a 64-character hex key on the server before saving credentials.',
      };
    }
  }
  await db().transaction(async (tx) => {
    if (revoke) await tx.delete(credentials).where(eq(credentials.agentId, agentId));
    else
      await tx
        .insert(credentials)
        .values({ agentId, encryptedKey })
        .onConflictDoUpdate({ target: credentials.agentId, set: { encryptedKey } });
    await tx.insert(audit).values({
      actor,
      action: `${revoke ? 'Revoked' : 'Replaced'} OpenRouter credential for agent ${agentId}`,
    });
  });
  revalidatePath(`/agents/${agentId}`);
  return { message: revoke ? 'Credential removed.' : 'Credential saved encrypted.' };
}
export async function runSimulation(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const agentId = uuid.parse(form.get('agentId'));
  const configurationId = uuid.parse(form.get('configurationId'));
  const input = z.string().trim().min(1).max(16000).safeParse(form.get('input'));
  if (!input.success) return { error: 'Paste a post or question with 1–16,000 characters.' };
  const result = await executeSimulation({ actor, agentId, configurationId, input: input.data });
  revalidatePath(`/agents/${agentId}`);
  return result;
}
