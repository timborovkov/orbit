'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { agents, audit } from '@/lib/schema';
import { deletePicture, putPicture, storageConfigured } from '@/lib/storage/objects';
import { maxPictureBytes, normalizePicture } from '@/lib/storage/pictures';

export async function savePicture(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const parsed = z.uuid().safeParse(form.get('agentId'));
  if (!parsed.success) return { error: 'Agent not found.' };
  const agentId = parsed.data;
  if (!(await db().select({ id: agents.id }).from(agents).where(eq(agents.id, agentId))).length)
    return { error: 'Agent not found.' };
  if (!storageConfigured())
    return {
      error: 'Picture storage is not configured. Ask your administrator to connect RustFS.',
    };
  const remove = form.get('remove') === 'true';
  let key: string | null = null;
  if (!remove) {
    const file = form.get('picture');
    if (!(file instanceof File) || !file.size || file.size > maxPictureBytes)
      return { error: 'Choose a picture smaller than 5 MB.' };
    let bytes: Buffer;
    try {
      bytes = await normalizePicture(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unable to read picture.' };
    }
    key = `agents/${agentId}/pictures/${randomUUID()}.webp`;
    try {
      await putPicture(key, bytes);
    } catch {
      return {
        error: 'Picture storage is unavailable. Your existing picture is unchanged. Try again.',
      };
    }
  }
  let previous: string | null;
  try {
    previous = await db().transaction(async (tx) => {
      const agent = (await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')).at(
        0,
      );
      if (!agent) throw new Error('Agent not found');
      await tx.update(agents).set({ pictureKey: key }).where(eq(agents.id, agentId));
      await tx.insert(audit).values({
        actor,
        action: `${remove ? 'Removed' : 'Updated'} profile picture for agent ${agentId}`,
      });
      return agent.pictureKey;
    });
  } catch {
    if (key) await cleanup(key, actor);
    return { error: 'Unable to save the picture. Try again.' };
  }
  const cleaned = !previous || (await cleanup(previous, actor));
  revalidatePath('/');
  revalidatePath(`/agents/${agentId}`);
  return {
    message: `${remove ? 'Picture removed.' : 'Picture saved.'}${cleaned ? '' : ' Previous file cleanup is pending; an audit entry records its reference.'}`,
  };
}
async function cleanup(key: string, actor: string) {
  try {
    await deletePicture(key);
    return true;
  } catch {
    await db()
      .insert(audit)
      .values({ actor, action: `Picture storage cleanup required: ${key}` });
    return false;
  }
}
