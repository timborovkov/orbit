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
import { supportsPersonFact } from '@/lib/runtime/memory/person-source';
import {
  MEMORY_CAPTURE,
  MEMORY_EMBED_JOB,
  type MemoryCandidate,
  memoryCandidate,
  type MemoryRef,
  personMemoryLabels,
  personMemoryStatement,
  personMemorySubject,
} from '@/lib/runtime/memory/types';
import { actionIntents, agentMemories, runMemoryEvidence, type runs } from '@/lib/schema';

type MemoryRun = Pick<typeof runs.$inferSelect, 'id' | 'agentId' | 'actor'>;
type EntryKey = MemoryRef & { agentId: string };

export async function memoryRunSource(run: MemoryRun, store: Tx | ReturnType<typeof db> = db()) {
  const [match, other] = await store
    .select({
      sourceId: runMemoryEvidence.sourceId,
      sourceKind: runMemoryEvidence.sourceKind,
      sourceAt: runMemoryEvidence.sourceAt,
      title: runMemoryEvidence.title,
      body: runMemoryEvidence.body,
      author: runMemoryEvidence.author,
      personIdentityId: runMemoryEvidence.personIdentityId,
    })
    .from(runMemoryEvidence)
    .where(and(eq(runMemoryEvidence.agentId, run.agentId), eq(runMemoryEvidence.runId, run.id)))
    .limit(2);
  if (!match || other) return null;
  const { title, body: rawBody, ...source } = match;
  const body = rawBody.slice(0, 8_000);
  return { ...source, body, text: title ? [title, body] : [body] };
}

function topicKey(candidate: { subject: string; topic: string }) {
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
  return JSON.stringify([normalize(candidate.subject), normalize(candidate.topic)]);
}

type CaptureEvidence = NonNullable<Awaited<ReturnType<typeof memoryRunSource>>>;

function identityKey(candidate: MemoryCandidate, evidence: CaptureEvidence) {
  return candidate.subjectKind === 'person'
    ? JSON.stringify([evidence.personIdentityId, candidate.personFact.field])
    : `[${JSON.stringify(evidence.personIdentityId)},${topicKey(candidate)}]`;
}

export function verifiedMemoryCandidates(
  candidates: unknown[] | undefined,
  evidence: CaptureEvidence,
) {
  const seen = new Set<string>();
  return (candidates ?? []).slice(0, 3).flatMap((raw) => {
    const parsed = memoryCandidate.safeParse(raw);
    if (!parsed.success) return [];
    const candidate = parsed.data;
    if (candidate.subjectKind === 'note' && !candidate.subject) {
      candidate.subject = evidence.author ? personMemorySubject(evidence.author) : 'Interaction';
    }
    if (candidate.subjectKind === 'person') {
      if (
        !evidence.personIdentityId ||
        !supportsPersonFact(
          evidence.body,
          candidate.quote,
          candidate.personFact.field,
          candidate.personFact.value,
        )
      )
        return [];
    } else if (!evidence.text.some((text) => text.includes(candidate.quote))) return [];
    const key = JSON.stringify([candidate.subjectKind, identityKey(candidate, evidence)]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [candidate];
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

  const verified = verifiedMemoryCandidates(candidates, evidence);
  if (!verified.length) return;
  const learnedAt = new Date();
  const entries = await tx
    .insert(agentMemories)
    .values(
      verified.map((candidate) => {
        const fields =
          candidate.subjectKind === 'person'
            ? personFields(candidate.personFact, evidence.author)
            : {
                subject: candidate.subject,
                topic: candidate.topic,
                fact: candidate.subjectKind === 'note' ? candidate.note.text : candidate.fact,
                note: candidate.subjectKind === 'note' ? candidate.note : null,
              };
        return {
          ...fields,
          subjectKind: candidate.subjectKind,
          quote: candidate.quote,
          expiresOn: candidate.expiresOn,
          reviewOn: candidate.reviewOn,
          identityKey: identityKey(candidate, evidence),
          agentId: run.agentId,
          runId: run.id,
          sourceKind: evidence.sourceKind,
          sourceId: evidence.sourceId,
          sourceAt: evidence.sourceAt,
          learnedAt,
        };
      }),
    )
    .onConflictDoUpdate({
      target: [agentMemories.agentId, agentMemories.subjectKind, agentMemories.identityKey],
      set: {
        subject: sql`excluded.subject`,
        topic: sql`excluded.topic`,
        fact: sql`excluded.fact`,
        personValue: sql`excluded.person_value`,
        note: sql`excluded.note`,
        quote: sql`excluded.quote`,
        runId: sql`excluded.run_id`,
        sourceKind: sql`excluded.source_kind`,
        sourceId: sql`excluded.source_id`,
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
        sql`(excluded.subject_kind <> 'person' OR ${agentMemories.personValue} IS DISTINCT FROM excluded.person_value)`,
      ),
    })
    .returning({
      id: agentMemories.id,
      agentId: agentMemories.agentId,
      revision: agentMemories.revision,
      subjectKind: agentMemories.subjectKind,
    });
  await Promise.all(
    entries
      .filter(({ subjectKind }) => subjectKind !== 'person')
      .map((entry) => enqueueMemoryEmbedding(tx, entry)),
  );
}

function personFields(
  { field, value }: Extract<MemoryCandidate, { subjectKind: 'person' }>['personFact'],
  author: string | null,
) {
  const subject = personMemorySubject(author);
  return {
    subject,
    topic: personMemoryLabels[field],
    fact: personMemoryStatement(subject, field, value),
    personField: field,
    personValue: value,
  };
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
