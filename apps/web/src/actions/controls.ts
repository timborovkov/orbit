'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { audit, controls } from '@/lib/schema';

export async function setGlobalPause(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const paused = z.enum(['true', 'false']).parse(form.get('paused')) === 'true';
  await db().transaction(async (tx) => {
    const states = await tx.update(controls).set({ paused }).where(eq(controls.id, 1)).returning();
    const state = states.at(0);
    if (!state) throw new Error('Outbound control is missing');
    await tx.insert(audit).values({
      actor,
      action: state.paused ? 'Global outbound pause enabled' : 'Global outbound pause released',
    });
  });
  revalidatePath('/');
}
