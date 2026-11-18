'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import {
  deleteSkill,
  persistAgentSkills,
  persistSkill,
  skillInput,
} from '@/lib/server/skills-mutations';

const uuid = z.uuid();

export async function saveSkill(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const parsed = skillInput.safeParse({
    name: form.get('name'),
    title: form.get('title'),
    description: form.get('description'),
    body: form.get('body'),
  });
  if (!parsed.success) {
    return {
      error: 'Check the slug, title, description and Markdown body lengths.',
    };
  }
  const skillIdRaw = form.get('skillId');
  const skillId =
    typeof skillIdRaw === 'string' && skillIdRaw.trim() !== '' ? uuid.parse(skillIdRaw) : undefined;
  const result = await persistSkill(actor, parsed.data, skillId);
  if ('error' in result) return result;
  revalidatePath('/skills');
  revalidatePath('/');
  return {
    message: skillId ? `Saved skill v${result.version}.` : 'Skill created.',
  };
}

export async function removeSkill(form: FormData): Promise<void> {
  await checkOrigin();
  const actor = await requireAdmin();
  const skillId = uuid.parse(form.get('skillId'));
  await deleteSkill(actor, skillId);
  revalidatePath('/skills');
  revalidatePath('/');
}

export async function saveAgentSkills(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const agentId = uuid.parse(form.get('agentId'));
  const skillIds = form
    .getAll('skillId')
    .flatMap((value) => (typeof value === 'string' && value ? [uuid.parse(value)] : []));
  const result = await persistAgentSkills(actor, agentId, skillIds);
  if ('error' in result) return result;
  revalidatePath(`/agents/${agentId}`);
  return { message: `Attached ${result.count} skill${result.count === 1 ? '' : 's'}.` };
}
