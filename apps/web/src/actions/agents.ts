'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { agents, audit } from '@/lib/schema';

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
  const data = parsed.data;
  await db().transaction(async (tx) => {
    await tx.insert(agents).values(data);
    await tx.insert(audit).values({ actor, action: `Created paused agent: ${data.name}` });
  });
  revalidatePath('/');
  return { ok: true as const };
}
