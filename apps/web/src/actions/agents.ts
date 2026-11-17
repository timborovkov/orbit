'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { createAgentFromTemplate } from '@/lib/server/agents-mutations';

export async function createAgent(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(80),
      mission: z.string().trim().min(1).max(2000),
    })
    .safeParse({ name: form.get('name'), mission: form.get('mission') });
  if (!parsed.success)
    return { ok: false as const, errors: z.flattenError(parsed.error).fieldErrors };
  const templateId = z
    .string()
    .max(80)
    .parse(form.get('templateId') ?? 'blank');
  const result = await createAgentFromTemplate(actor, templateId, parsed.data);
  if (!result.ok) return result;
  revalidatePath('/');
  return { ok: true as const };
}
