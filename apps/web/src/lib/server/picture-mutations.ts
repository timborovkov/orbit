import 'server-only';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { agents, audit } from '@/lib/schema';
import { deletePicture, putPicture, storageConfigured } from '@/lib/storage/objects';
import { normalizePicture } from '@/lib/storage/pictures';

export async function persistPicture(actor: string, agentId: string, input: Uint8Array | null) {
  const remove = input === null;
  if (!(await db().select({ id: agents.id }).from(agents).where(eq(agents.id, agentId))).length)
    return { error: 'Agent not found.' };
  if (!storageConfigured())
    return {
      error: 'Picture storage is not configured. Ask your administrator to connect RustFS.',
    };
  let key: string | null = null;
  if (input !== null) {
    let bytes: Buffer;
    try {
      bytes = await normalizePicture(input);
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
