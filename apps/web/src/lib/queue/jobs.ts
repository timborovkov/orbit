import { and, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';

import { db, sqlClient, type Db, type Tx } from '@/lib/db';
import {
  backoffMs,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  type ClaimOptions,
  type EnqueueInput,
  type JobRecord,
} from '@/lib/queue/types';
import { jobs } from '@/lib/schema';

type Store = Db | Tx;

function mapJob(row: typeof jobs.$inferSelect): JobRecord {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    status: row.status as JobRecord['status'],
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    availableAt: row.availableAt,
    claimedAt: row.claimedAt,
    claimExpiresAt: row.claimExpiresAt,
    claimedBy: row.claimedBy,
    finishedAt: row.finishedAt,
    lastError: row.lastError,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapRawJob(row: Record<string, unknown>): JobRecord {
  return mapJob({
    id: String(row.id),
    type: String(row.type),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    status: String(row.status),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: new Date(String(row.available_at)),
    claimedAt: row.claimed_at ? new Date(String(row.claimed_at)) : null,
    claimExpiresAt: row.claim_expires_at ? new Date(String(row.claim_expires_at)) : null,
    claimedBy: row.claimed_by ? String(row.claimed_by) : null,
    finishedAt: row.finished_at ? new Date(String(row.finished_at)) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  });
}

/** Insert a job inside an existing transaction (or a fresh one). Idempotent on key. */
export async function enqueueJob(store: Store, input: EnqueueInput): Promise<JobRecord> {
  const values = {
    type: input.type,
    payload: input.payload,
    idempotencyKey: input.idempotencyKey ?? null,
    availableAt: input.availableAt ?? new Date(),
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  };
  if (values.idempotencyKey) {
    const existing = (
      await store
        .select()
        .from(jobs)
        .where(eq(jobs.idempotencyKey, values.idempotencyKey))
        .limit(1)
    ).at(0);
    if (existing) return mapJob(existing);
  }
  const inserted = (await store.insert(jobs).values(values).returning()).at(0);
  if (!inserted) throw new Error('Job insert failed');
  return mapJob(inserted);
}

export async function enqueueJobInTransaction(
  input: EnqueueInput,
  work: (tx: Tx, job: JobRecord) => Promise<void>,
): Promise<JobRecord> {
  return await db().transaction(async (tx) => {
    const job = await enqueueJob(tx, input);
    await work(tx, job);
    return job;
  });
}

/**
 * Claim pending (or expired-lease) jobs with FOR UPDATE SKIP LOCKED.
 * Contending workers never block each other on the same rows.
 */
export async function claimJobs(options: ClaimOptions): Promise<JobRecord[]> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const limit = options.limit ?? 1;
  const now = new Date();
  const expiry = new Date(now.getTime() + leaseMs);
  const client = sqlClient();

  const rows = options.types?.length
    ? await client`
        WITH candidate AS (
          SELECT id FROM jobs
          WHERE (
            (status = 'pending' AND available_at <= ${now})
            OR (status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at < ${now})
          )
          AND type = ANY(${options.types})
          ORDER BY available_at ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE jobs AS j
        SET
          status = 'claimed',
          attempts = j.attempts + 1,
          claimed_at = ${now},
          claim_expires_at = ${expiry},
          claimed_by = ${options.workerId},
          updated_at = ${now}
        FROM candidate
        WHERE j.id = candidate.id
        RETURNING j.*
      `
    : await client`
        WITH candidate AS (
          SELECT id FROM jobs
          WHERE (
            (status = 'pending' AND available_at <= ${now})
            OR (status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at < ${now})
          )
          ORDER BY available_at ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE jobs AS j
        SET
          status = 'claimed',
          attempts = j.attempts + 1,
          claimed_at = ${now},
          claim_expires_at = ${expiry},
          claimed_by = ${options.workerId},
          updated_at = ${now}
        FROM candidate
        WHERE j.id = candidate.id
        RETURNING j.*
      `;

  return rows.map((row) => mapRawJob(row as Record<string, unknown>));
}

export async function heartbeatJob(
  jobId: string,
  workerId: string,
  leaseMs = DEFAULT_LEASE_MS,
  store: Store = db(),
): Promise<boolean> {
  const now = new Date();
  const expiry = new Date(now.getTime() + leaseMs);
  const updated = await store
    .update(jobs)
    .set({ claimExpiresAt: expiry, updatedAt: now })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'claimed'), eq(jobs.claimedBy, workerId)))
    .returning({ id: jobs.id });
  return updated.length > 0;
}

export async function completeJob(
  jobId: string,
  workerId: string,
  store: Store = db(),
): Promise<void> {
  const now = new Date();
  await store
    .update(jobs)
    .set({
      status: 'completed',
      finishedAt: now,
      claimExpiresAt: null,
      updatedAt: now,
      lastError: null,
    })
    .where(and(eq(jobs.id, jobId), eq(jobs.claimedBy, workerId), eq(jobs.status, 'claimed')));
}

export async function failJob(
  jobId: string,
  workerId: string,
  error: string,
  store: Store = db(),
): Promise<JobRecord | null> {
  const now = new Date();
  const current = (
    await store
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.claimedBy, workerId), eq(jobs.status, 'claimed')))
      .for('update')
  ).at(0);
  if (!current) return null;

  const dead = current.attempts >= current.maxAttempts;
  const availableAt = dead ? now : new Date(now.getTime() + backoffMs(current.attempts));
  const updated = (
    await store
      .update(jobs)
      .set({
        status: dead ? 'dead' : 'pending',
        lastError: error.slice(0, 4000),
        availableAt,
        claimedAt: null,
        claimExpiresAt: null,
        claimedBy: null,
        finishedAt: dead ? now : null,
        updatedAt: now,
      })
      .where(eq(jobs.id, jobId))
      .returning()
  ).at(0);
  return updated ? mapJob(updated) : null;
}

/** Recover expired leases back to pending without waiting for a claim race. */
export async function recoverExpiredLeases(store: Store = db()): Promise<number> {
  const now = new Date();
  const recovered = await store
    .update(jobs)
    .set({
      status: 'pending',
      claimedAt: null,
      claimExpiresAt: null,
      claimedBy: null,
      updatedAt: now,
      availableAt: now,
    })
    .where(
      and(eq(jobs.status, 'claimed'), isNotNull(jobs.claimExpiresAt), lt(jobs.claimExpiresAt, now)),
    )
    .returning({ id: jobs.id });
  return recovered.length;
}

export async function cancelJobsByIds(ids: string[], store: Store = db()): Promise<number> {
  if (!ids.length) return 0;
  const now = new Date();
  const cancelled = await store
    .update(jobs)
    .set({
      status: 'cancelled',
      finishedAt: now,
      claimExpiresAt: null,
      claimedBy: null,
      updatedAt: now,
    })
    .where(
      and(inArray(jobs.id, ids), or(eq(jobs.status, 'pending'), eq(jobs.status, 'claimed'))),
    )
    .returning({ id: jobs.id });
  return cancelled.length;
}

export async function cancelPendingJobsForAgent(
  agentId: string,
  store: Store = db(),
): Promise<number> {
  const now = new Date();
  const result = await store.execute(sql`
    UPDATE jobs
    SET
      status = 'cancelled',
      finished_at = ${now},
      claim_expires_at = NULL,
      claimed_by = NULL,
      updated_at = ${now}
    WHERE status IN ('pending', 'claimed')
      AND payload->>'agentId' = ${agentId}
    RETURNING id
  `);
  return Array.isArray(result) ? result.length : 0;
}

export async function getJob(id: string, store: Store = db()): Promise<JobRecord | null> {
  const row = (await store.select().from(jobs).where(eq(jobs.id, id))).at(0);
  return row ? mapJob(row) : null;
}
