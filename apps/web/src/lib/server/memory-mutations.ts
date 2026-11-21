import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { enqueueMemoryEmbedding } from '@/lib/runtime/memory/store';
import { personMemoryStatement } from '@/lib/runtime/memory/types';
import { agentMemories, audit } from '@/lib/schema';

type EditKey = { agentId: string; id: string; revision: string };
type Correction = { expiresOn: string | null; reviewOn: string | null } & (
  { fact: string; personValue?: never } | { personValue: string; fact?: never }
);

const stale = { error: 'This memory changed or was removed. Refresh and try again.' };

export function saveAgentMemory(actor: string, key: EditKey, correction?: Correction) {
  const target = and(
    eq(agentMemories.agentId, key.agentId),
    eq(agentMemories.id, key.id),
    eq(agentMemories.revision, key.revision),
  );
  return db().transaction(async (tx) => {
    if (correction) {
      const [current] = await tx
        .select({ subject: agentMemories.subject, personField: agentMemories.personField })
        .from(agentMemories)
        .where(target)
        .for('update');
      if (!current) return stale;
      const { personField, subject } = current;
      const personValue = correction.personValue;
      const fact =
        personField && personValue
          ? personMemoryStatement(subject, personField, personValue)
          : correction.fact;
      if (!fact || Boolean(personField) !== Boolean(personValue)) {
        return { error: 'Use the correction field for this memory.' };
      }
      const [entry] = await tx
        .update(agentMemories)
        .set({
          fact,
          personValue: personValue ?? null,
          expiresOn: correction.expiresOn,
          reviewOn: correction.reviewOn,
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
      if (!personField) await enqueueMemoryEmbedding(tx, entry);
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
