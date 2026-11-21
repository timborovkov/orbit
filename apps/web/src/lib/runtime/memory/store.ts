import { and, eq, isNull, sql } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import { authorizeAction, loadPolicyContext } from '@/lib/policy/gateway';
import { enqueueJob } from '@/lib/queue/jobs';
import {
  knowledgeEmbeddingDimensions,
  knowledgeEmbeddingModelId,
  validateKnowledgeVector,
} from '@/lib/runtime/knowledge/embed';
import { resolveKnowledgeEmbedders } from '@/lib/runtime/knowledge/provider';
import {
  MEMORY_CAPTURE,
  MEMORY_EMBED_JOB,
  type MemoryCandidate,
  memoryCandidate,
  type MemoryRef,
} from '@/lib/runtime/memory/types';
import { actionIntents, agentMemories, emailMessages, type runs, sourceEvents } from '@/lib/schema';

type MemoryRun = Pick<typeof runs.$inferSelect, 'id' | 'agentId' | 'actor' | 'origin'>;
type EntryKey = MemoryRef & { agentId: string };

export async function memoryRunSource(run: MemoryRun, store: Tx | ReturnType<typeof db> = db()) {
  if (run.origin === 'email') {
    const message = (
      await store
        .select({
          id: emailMessages.id,
          at: emailMessages.receivedAt,
          subject: emailMessages.subject,
          body: emailMessages.body,
        })
        .from(emailMessages)
        .where(and(eq(emailMessages.agentId, run.agentId), eq(emailMessages.runId, run.id)))
    ).at(0);
    if (!message?.body) return null;
    return {
      emailMessageId: message.id,
      sourceEventId: null,
      sourceAt: message.at,
      text: [message.subject, message.body.slice(0, 8_000)],
    };
  }
  if (run.origin === 'discovery') {
    const event = (
      await store
        .select({
          id: sourceEvents.id,
          at: sql<Date>`coalesce(${sourceEvents.providerCreatedAt}, ${sourceEvents.ingestedAt})`.mapWith(
            sourceEvents.ingestedAt,
          ),
          text: sourceEvents.text,
        })
        .from(sourceEvents)
        .where(and(eq(sourceEvents.agentId, run.agentId), eq(sourceEvents.runId, run.id)))
    ).at(0);
    if (!event) return null;
    return {
      emailMessageId: null,
      sourceEventId: event.id,
      sourceAt: event.at,
      text: [event.text],
    };
  }
  return null;
}

function identityKey(candidate: Pick<MemoryCandidate, 'subject' | 'topic'>) {
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
  return JSON.stringify([normalize(candidate.subject), normalize(candidate.topic)]);
}

export function verifiedMemoryCandidates(candidates: unknown[] | undefined, evidence: string[]) {
  const seen = new Set<string>();
  return (candidates ?? []).slice(0, 3).flatMap((raw) => {
    const parsed = memoryCandidate.safeParse(raw);
    if (!parsed.success || !evidence.some((text) => text.includes(parsed.data.quote))) return [];
    const key = JSON.stringify([parsed.data.subjectKind, identityKey(parsed.data)]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [parsed.data];
  });
}

export async function enqueueMemoryEmbedding(tx: Tx, entry: EntryKey) {
  await enqueueJob(tx, {
    type: MEMORY_EMBED_JOB,
    payload: entry,
    idempotencyKey: `${MEMORY_EMBED_JOB}:${entry.id}:${entry.revision}`,
    maxAttempts: 3,
  });
}

/** The caller holds the agent lock and commits capture with the run outcome. */
export async function captureRunMemories(
  tx: Tx,
  run: MemoryRun,
  executionToken: string,
  candidates: MemoryCandidate[] | undefined,
) {
  if (!candidates?.length) return;
  const idempotencyKey = `${MEMORY_CAPTURE}:${run.id}`;
  const receipt = (
    await tx
      .select({ id: actionIntents.id })
      .from(actionIntents)
      .where(
        and(
          eq(actionIntents.agentId, run.agentId),
          eq(actionIntents.idempotencyKey, idempotencyKey),
        ),
      )
  ).at(0);
  if (receipt) return;

  const ctx = await loadPolicyContext(run.agentId, run.actor, run.id, tx);
  if (!ctx) return;
  const policy = await authorizeAction(
    ctx,
    { type: MEMORY_CAPTURE, idempotencyKey, executionToken },
    tx,
  );
  if (policy.decision !== 'allow') return;
  const evidence = await memoryRunSource(run, tx);
  if (!evidence) return;

  const verified = verifiedMemoryCandidates(candidates, evidence.text);
  if (!verified.length) return;
  const learnedAt = new Date();
  const entries = await tx
    .insert(agentMemories)
    .values(
      verified.map(({ subjectKind, subject, topic, fact, quote, expiresOn, reviewOn }) => ({
        subjectKind,
        subject,
        topic,
        fact,
        quote,
        expiresOn,
        reviewOn,
        identityKey: identityKey({ subject, topic }),
        agentId: run.agentId,
        runId: run.id,
        emailMessageId: evidence.emailMessageId,
        sourceEventId: evidence.sourceEventId,
        sourceAt: evidence.sourceAt,
        learnedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [agentMemories.agentId, agentMemories.subjectKind, agentMemories.identityKey],
      set: {
        subject: sql`excluded.subject`,
        topic: sql`excluded.topic`,
        fact: sql`excluded.fact`,
        quote: sql`excluded.quote`,
        runId: sql`excluded.run_id`,
        emailMessageId: sql`excluded.email_message_id`,
        sourceEventId: sql`excluded.source_event_id`,
        sourceAt: evidence.sourceAt,
        learnedAt,
        expiresOn: sql`excluded.expires_on`,
        reviewOn: sql`excluded.review_on`,
        revision: sql`excluded.revision`,
        embedding: null,
        embeddingModel: null,
      },
      setWhere: and(
        isNull(agentMemories.correctedBy),
        sql`${agentMemories.sourceAt} < excluded.source_at`,
      ),
    })
    .returning({
      id: agentMemories.id,
      agentId: agentMemories.agentId,
      revision: agentMemories.revision,
    });
  await Promise.all(entries.map((entry) => enqueueMemoryEmbedding(tx, entry)));
}

export async function processMemoryEmbedding(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const { id, agentId, revision } = payload;
  if (typeof id !== 'string' || typeof agentId !== 'string' || typeof revision !== 'string') return;
  const scope = and(
    eq(agentMemories.id, id),
    eq(agentMemories.agentId, agentId),
    eq(agentMemories.revision, revision),
    isNull(agentMemories.embedding),
  );
  const [entry] = await db()
    .select({
      subject: agentMemories.subject,
      topic: agentMemories.topic,
      fact: agentMemories.fact,
    })
    .from(agentMemories)
    .where(scope);
  if (!entry) return;
  signal?.throwIfAborted();
  const provider = await resolveKnowledgeEmbedders(agentId);
  const embedding = validateKnowledgeVector(
    await provider.embedOne(`${entry.subject} ${entry.topic}: ${entry.fact}`, signal),
    knowledgeEmbeddingDimensions(),
  );
  signal?.throwIfAborted();
  await db()
    .update(agentMemories)
    .set({ embedding, embeddingModel: knowledgeEmbeddingModelId() })
    .where(scope);
}
