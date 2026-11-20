import 'server-only';

import { eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { audit, controls } from '@/lib/schema';

export async function persistGlobalPause(actor: string, paused: boolean) {
  await db().transaction(async (tx) => {
    // Row lock pairs with outbound dispatch, which holds controls FOR UPDATE through send.
    const locked = (
      await tx.select({ id: controls.id }).from(controls).where(eq(controls.id, 1)).for('update')
    ).at(0);
    if (!locked) throw new Error('Outbound control is missing');
    const states = await tx.update(controls).set({ paused }).where(eq(controls.id, 1)).returning();
    const state = states.at(0);
    if (!state) throw new Error('Outbound control is missing');
    await tx.insert(audit).values({
      actor,
      action: state.paused ? 'Global outbound pause enabled' : 'Global outbound pause released',
    });
  });
}
