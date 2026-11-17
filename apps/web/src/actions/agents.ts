'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { agents, audit, configurations, templates } from '@/lib/schema';

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
  const template = (await db().select().from(templates).where(eq(templates.id, templateId))).at(0);
  if (!template) return { ok: false as const, errors: { name: ['Choose an available template.'] } };
  const data = parsed.data;
  await db().transaction(async (tx) => {
    const agent = (await tx.insert(agents).values(data).returning()).at(0);
    if (!agent) throw new Error('Agent insert failed');
    await tx
      .insert(configurations)
      .values({ agentId: agent.id, version: 1, actor, config: { ...template.config, ...data } });
    await tx.insert(audit).values({ actor, action: `Created paused agent: ${data.name}` });
  });
  revalidatePath('/');
  return { ok: true as const };
}
