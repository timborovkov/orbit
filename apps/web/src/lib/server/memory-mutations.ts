import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { enqueueMemoryEmbedding } from '@/lib/runtime/memory/store';
import { agentMemories, audit } from '@/lib/schema';

type EditKey = { agentId: string; id: string; revision: string };
type Correction = { fact: string; expiresOn: string | null; reviewOn: string | null };

const stale = { error: 'This memory changed or was removed. Refresh and try again.' };

export function saveAgentMemory(actor: string, key: EditKey, correction?: Correction) {
  const target = and(
    eq(agentMemories.agentId, key.agentId),
    eq(agentMemories.id, key.id),
    eq(agentMemories.revision, key.revision),
  );
  return db().transaction(async (tx) => {
    if (correction) {
      const [entry] = await tx
        .update(agentMemories)
        .set({
          ...correction,
          correctedBy: actor,
          correctedAt: new Date(),
          revision: randomUUID(),
          embedding: null,
          embeddingModel: null,
        })
        .where(target)
        .returning({
          id: agentMemories.id,
          agentId: agentMemories.agentId,
          revision: agentMemories.revision,
        });
      if (!entry) return stale;
      await enqueueMemoryEmbedding(tx, entry);
    } else {
      const [entry] = await tx
        .delete(agentMemories)
        .where(target)
        .returning({ id: agentMemories.id });
      if (!entry) return stale;
    }
    await tx.insert(audit).values({
      actor,
      action: `${correction ? 'Corrected' : 'Removed'} memory ${key.id} for agent ${key.agentId}`,
    });
    return { message: correction ? 'Memory corrected.' : 'Memory removed.' };
  });
}
