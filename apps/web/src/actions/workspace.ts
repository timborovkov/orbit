'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { configSchema } from '@/lib/runtime/config';
import { executeSimulation } from '@/lib/runtime/execute';
import {
  persistConfiguration,
  persistCredential,
  persistTemplate,
} from '@/lib/server/workspace-mutations';

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
  const saved = await persistConfiguration(actor, agentId, version, parsed.data);
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
  const saved = await persistTemplate(actor, id, revision, parsed.data);
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
  const result = await persistCredential(actor, agentId, secret.success ? secret.data : '', revoke);
  if ('error' in result) return result;
  revalidatePath(`/agents/${agentId}`);
  return result;
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
