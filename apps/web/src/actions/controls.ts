'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { persistGlobalPause } from '@/lib/server/controls-mutations';

export async function setGlobalPause(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const paused = z.enum(['true', 'false']).parse(form.get('paused')) === 'true';
  await persistGlobalPause(actor, paused);
  revalidatePath('/');
}
