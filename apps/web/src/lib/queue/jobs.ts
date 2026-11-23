import { and, eq, gt, inArray, sql } from 'drizzle-orm';

import { type Db, db, sqlClient, type Tx } from '@/lib/db';
import {
  backoffMs,
  type ClaimOptions,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  type EnqueueInput,
  type JobClaimIdentity,
  type JobRecord,
} from '@/lib/queue/types';
import { jobs } from '@/lib/schema';

type Store = Db | Tx;

/** A worker may only mutate a live lease from the claim it processed. */
export function activeJobClaim(jobId: string, workerId: string, claim?: JobClaimIdentity) {
  return and(
    eq(jobs.id, jobId),
    eq(jobs.status, 'claimed'),
    eq(jobs.claimedBy, workerId),
    gt(jobs.claimExpiresAt, sql`clock_timestamp()`),
    claim ? eq(jobs.attempts, claim.attempts) : undefined,
    claim?.claimedAt
      ? sql`date_trunc('milliseconds', ${jobs.claimedAt}) = ${claim.claimedAt.toISOString()}::timestamptz`
      : undefined,
  );
}

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

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return '';
  throw new Error('Unexpected job column type');
}

function asOptionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : asText(value);
}

function mapRawJob(row: Record<string, unknown>): JobRecord {
  return mapJob({
    id: asText(row.id),
    type: asText(row.type),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    status: asText(row.status),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: new Date(asText(row.available_at)),
    claimedAt:
      row.claimed_at === null || row.claimed_at === undefined
        ? null
        : new Date(asText(row.claimed_at)),
    claimExpiresAt:
      row.claim_expires_at === null || row.claim_expires_at === undefined
        ? null
        : new Date(asText(row.claim_expires_at)),
    claimedBy: asOptionalText(row.claimed_by),
    finishedAt:
      row.finished_at === null || row.finished_at === undefined
        ? null
        : new Date(asText(row.finished_at)),
    lastError: asOptionalText(row.last_error),
    idempotencyKey: asOptionalText(row.idempotency_key),
    createdAt: new Date(asText(row.created_at)),
    updatedAt: new Date(asText(row.updated_at)),
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
      await store.select().from(jobs).where(eq(jobs.idempotencyKey, values.idempotencyKey)).limit(1)
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
  // Use Postgres now() for availability/lease checks so JS clock skew cannot miss
  // rows that were just marked available_at=now() on another connection.
  const expiryMs = leaseMs;
  const client = sqlClient();

  // Expired claims are only reclaimable while attempts remain; exhausted leases are dead-lettered by recovery.
  const rows = options.types?.length
    ? await client`
        WITH candidate AS (
          SELECT id FROM jobs
          WHERE (
            (status = 'pending' AND available_at <= now())
            OR (
              status = 'claimed'
              AND claim_expires_at IS NOT NULL
              AND claim_expires_at <= now()
              AND attempts < max_attempts
            )
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
          claimed_at = now(),
          claim_expires_at = now() + (${expiryMs}::text || ' milliseconds')::interval,
          claimed_by = ${options.workerId},
          updated_at = now()
        FROM candidate
        WHERE j.id = candidate.id
        RETURNING j.*
      `
    : await client`
        WITH candidate AS (
          SELECT id FROM jobs
          WHERE (
            (status = 'pending' AND available_at <= now())
            OR (
              status = 'claimed'
              AND claim_expires_at IS NOT NULL
              AND claim_expires_at <= now()
              AND attempts < max_attempts
            )
          )
          ORDER BY available_at ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE jobs AS j
        SET
          status = 'claimed',
          attempts = j.attempts + 1,
          claimed_at = now(),
          claim_expires_at = now() + (${expiryMs}::text || ' milliseconds')::interval,
          claimed_by = ${options.workerId},
          updated_at = now()
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
  claim?: JobClaimIdentity,
): Promise<boolean> {
  const updated = await store
    .update(jobs)
    .set({
      claimExpiresAt: sql`clock_timestamp() + ${leaseMs}::double precision * interval '1 millisecond'`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(activeJobClaim(jobId, workerId, claim))
    .returning({ id: jobs.id });
  return updated.length > 0;
}

export async function completeJob(
  jobId: string,
  workerId: string,
  store: Store = db(),
  claim?: JobClaimIdentity,
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
    .where(activeJobClaim(jobId, workerId, claim));
}

/**
 * Return an unexecuted claim to pending without counting a failure.
 * Decrements the attempt that claimJobs reserved so shutdown does not burn retries.
 */
export async function releaseClaim(
  jobId: string,
  workerId: string,
  store: Store = db(),
  availableAt = new Date(),
  claim?: JobClaimIdentity,
): Promise<JobRecord | null> {
  const now = new Date();
  const updated = (
    await store
      .update(jobs)
      .set({
        status: 'pending',
        attempts: sql`greatest(${jobs.attempts} - 1, 0)`,
        availableAt,
        claimedAt: null,
        claimExpiresAt: null,
        claimedBy: null,
        updatedAt: now,
      })
      .where(activeJobClaim(jobId, workerId, claim))
      .returning()
  ).at(0);
  return updated ? mapJob(updated) : null;
}

export async function failJob(
  jobId: string,
  workerId: string,
  error: string,
  store?: Store,
  claim?: JobClaimIdentity,
): Promise<JobRecord | null> {
  // FOR UPDATE only holds across statements inside a transaction; wrap by default.
  if (!store) {
    return db().transaction((tx) => failJob(jobId, workerId, error, tx, claim));
  }
  const now = new Date();
  const current = (
    await store
      .select()
      .from(jobs)
      .where(activeJobClaim(jobId, workerId, claim))
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
      .where(eq(jobs.id, current.id))
      .returning()
  ).at(0);
  return updated ? mapJob(updated) : null;
}

/**
 * Force a claimed job to dead without waiting for max attempts.
 * Used when ordinary retries would redispatch a paid model step that never burned durably.
 */
export async function deadLetterJob(
  jobId: string,
  workerId: string,
  error: string,
  store?: Store,
  claim?: JobClaimIdentity,
): Promise<JobRecord | null> {
  if (!store) {
    return db().transaction((tx) => deadLetterJob(jobId, workerId, error, tx, claim));
  }
  const now = new Date();
  const updated = (
    await store
      .update(jobs)
      .set({
        status: 'dead',
        lastError: error.slice(0, 4000),
        availableAt: now,
        claimedAt: null,
        claimExpiresAt: null,
        claimedBy: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(activeJobClaim(jobId, workerId, claim))
      .returning()
  ).at(0);
  return updated ? mapJob(updated) : null;
}

/**
 * Recover expired leases: retry when attempts remain, otherwise dead-letter.
 * Returns every updated job so callers can finalize domain state for dead letters.
 */
export async function recoverExpiredLeases(store: Store = db()): Promise<JobRecord[]> {
  const now = new Date().toISOString();
  const result = await store.execute(sql`
    UPDATE jobs
    SET
      status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
      last_error = CASE
        WHEN attempts >= max_attempts THEN coalesce(last_error, 'Lease expired after max attempts')
        ELSE last_error
      END,
      finished_at = CASE WHEN attempts >= max_attempts THEN ${now}::timestamptz ELSE NULL END,
      claimed_at = NULL,
      claim_expires_at = NULL,
      claimed_by = NULL,
      updated_at = ${now}::timestamptz,
      available_at = ${now}::timestamptz
    WHERE status = 'claimed'
      AND claim_expires_at IS NOT NULL
      AND claim_expires_at <= clock_timestamp()
    RETURNING *
  `);
  if (!Array.isArray(result)) return [];
  return result.map((row) => mapRawJob(row));
}

/** Fence domain-owned timers or worker runs while holding the agent lock. */
export async function cancelAgentJobs(store: Tx, agentId: string, jobIds: string[], now: Date) {
  if (!jobIds.length) return;
  await store
    .update(jobs)
    .set({
      status: 'cancelled',
      finishedAt: now,
      claimExpiresAt: null,
      claimedBy: null,
      updatedAt: now,
    })
    .where(
      and(
        inArray(jobs.id, jobIds),
        sql`${jobs.payload}->>'agentId' = ${agentId}`,
        sql`${jobs.status} IN ('pending', 'claimed')`,
      ),
    );
}

/**
 * Cancel queued jobs for an agent. Pause cancels pending only so in-flight claims can finish;
 * stop also cancels claimed jobs so workers abort via heartbeat lease loss.
 * Returns cancelled job ids so callers can interrupt linked retry-waiting runs.
 */
export async function cancelPendingJobsForAgent(
  agentId: string,
  store: Store = db(),
  options: { includeClaimed?: boolean; excludeTypes?: string[] } = {},
): Promise<string[]> {
  const now = new Date().toISOString();
  const statusFilter = options.includeClaimed
    ? sql`status IN ('pending', 'claimed')`
    : sql`status = 'pending'`;
  const excludeTypes = options.excludeTypes?.filter(Boolean) ?? [];
  const typeFilter = excludeTypes.length
    ? sql`AND type NOT IN (${sql.join(
        excludeTypes.map((type) => sql`${type}`),
        sql`, `,
      )})`
    : sql``;
  const result = await store.execute(sql`
    UPDATE jobs
    SET
      status = 'cancelled',
      finished_at = ${now}::timestamptz,
      claim_expires_at = NULL,
      claimed_by = NULL,
      updated_at = ${now}::timestamptz
    WHERE ${statusFilter}
      AND payload->>'agentId' = ${agentId}
      ${typeFilter}
    RETURNING id
  `);
  if (!Array.isArray(result)) return [];
  return result.map((row) => asText(row.id));
}
