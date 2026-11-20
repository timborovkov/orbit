'use server';

import { revalidatePath } from 'next/cache';

import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { persistPicture } from '@/lib/server/picture-mutations';
import { maxPictureBytes } from '@/lib/storage/pictures';

export async function savePicture(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const parsed = z.uuid().safeParse(form.get('agentId'));
  if (!parsed.success) return { error: 'Agent not found.' };
  const agentId = parsed.data;
  let input: Uint8Array | null = null;
  if (form.get('remove') !== 'true') {
    const file = form.get('picture');
    if (!(file instanceof File) || !file.size || file.size > maxPictureBytes)
      return { error: 'Choose a picture smaller than 5 MB.' };
    input = new Uint8Array(await file.arrayBuffer());
  }
  const result = await persistPicture(actor, agentId, input);
  if ('error' in result) return result;
  revalidatePath('/');
  revalidatePath(`/agents/${agentId}`);
  return result;
}
