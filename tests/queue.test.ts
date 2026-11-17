import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';

import { closeDb, db, sqlClient } from '@/lib/db';
import {
  cancelPendingJobsForAgent,
  claimJobs,
  completeJob,
  enqueueJob,
  enqueueJobInTransaction,
  failJob,
  heartbeatJob,
  recoverExpiredLeases,
} from '@/lib/queue/jobs';
import { startJobWorker } from '@/lib/queue/worker';

process.env.DATABASE_URL ??= 'postgres://orbit:orbit_dev@localhost:5432/orbit_test';
process.env.APP_URL ??= 'http://localhost:3000';
process.env.AUTH_DISABLED ??= 'false';
process.env.ORBIT_ADMIN_EMAIL ??= 'admin@example.com';
process.env.ORBIT_ADMIN_PASSWORD ??= 'test-only-password-123456';

const prefix = `queue-test-${randomUUID()}`;

afterAll(async () => {
  await sqlClient()`DELETE FROM jobs WHERE type LIKE ${prefix + '%'}`;
  await closeDb();
});

test('claim contention uses SKIP LOCKED so two workers never share a job', async () => {
  const key = `${prefix}:contention`;
  await enqueueJob(db(), {
    type: `${prefix}.work`,
    payload: { n: 1 },
    idempotencyKey: key,
  });
  const [a, b] = await Promise.all([
    claimJobs({ workerId: `${prefix}-a`, types: [`${prefix}.work`], limit: 1 }),
    claimJobs({ workerId: `${prefix}-b`, types: [`${prefix}.work`], limit: 1 }),
  ]);
  const claimed = [...a, ...b];
  expect(claimed).toHaveLength(1);
  await completeJob(claimed[0].id, claimed[0].claimedBy!);
});

test('lease expiry recovery returns jobs to pending', async () => {
  const job = await enqueueJob(db(), {
    type: `${prefix}.lease`,
    payload: {},
    idempotencyKey: `${prefix}:lease`,
  });
  const [claimed] = await claimJobs({
    workerId: `${prefix}-lease`,
    types: [`${prefix}.lease`],
    leaseMs: 1,
  });
  expect(claimed.id).toBe(job.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const recovered = await recoverExpiredLeases();
  expect(recovered).toBeGreaterThanOrEqual(1);
  const again = await claimJobs({
    workerId: `${prefix}-lease-2`,
    types: [`${prefix}.lease`],
  });
  expect(again).toHaveLength(1);
  await completeJob(again[0].id, `${prefix}-lease-2`);
  expect(await heartbeatJob(job.id, `${prefix}-lease-2`)).toBe(false);
});

test('expired leases at max attempts are dead-lettered instead of reclaimed', async () => {
  const job = await enqueueJob(db(), {
    type: `${prefix}.exhausted`,
    payload: {},
    idempotencyKey: `${prefix}:exhausted`,
    maxAttempts: 1,
  });
  const [claimed] = await claimJobs({
    workerId: `${prefix}-ex`,
    types: [`${prefix}.exhausted`],
    leaseMs: 1,
  });
  expect(claimed.id).toBe(job.id);
  expect(claimed.attempts).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const recovered = await recoverExpiredLeases();
  expect(recovered).toBeGreaterThanOrEqual(1);
  const [row] = await sqlClient()`SELECT status FROM jobs WHERE id = ${job.id}`;
  expect(row.status).toBe('dead');
  expect(
    await claimJobs({ workerId: `${prefix}-ex-2`, types: [`${prefix}.exhausted`] }),
  ).toHaveLength(0);
});

test('retries with backoff and dead-letter after max attempts', async () => {
  const job = await enqueueJob(db(), {
    type: `${prefix}.retry`,
    payload: {},
    idempotencyKey: `${prefix}:retry`,
    maxAttempts: 2,
  });
  const [first] = await claimJobs({ workerId: `${prefix}-r1`, types: [`${prefix}.retry`] });
  const failed = await failJob(first.id, `${prefix}-r1`, 'boom');
  expect(failed?.status).toBe('pending');
  expect(failed!.availableAt.getTime()).toBeGreaterThan(Date.now() - 1000);
  await sqlClient()`UPDATE jobs SET available_at = now() - interval '1 second' WHERE id = ${job.id}`;
  const [second] = await claimJobs({ workerId: `${prefix}-r2`, types: [`${prefix}.retry`] });
  const dead = await failJob(second.id, `${prefix}-r2`, 'boom again');
  expect(dead?.status).toBe('dead');
});

test('idempotency keys reuse the same job row', async () => {
  const first = await enqueueJobInTransaction(
    {
      type: `${prefix}.idem`,
      payload: { a: 1 },
      idempotencyKey: `${prefix}:idem`,
    },
    async () => {},
  );
  const second = await enqueueJob(db(), {
    type: `${prefix}.idem`,
    payload: { a: 2 },
    idempotencyKey: `${prefix}:idem`,
  });
  expect(second.id).toBe(first.id);
  expect(second.payload).toEqual({ a: 1 });
});

test('failJob does not overwrite a cancelled or reclaimed claim', async () => {
  const agentId = `${prefix}-agent-fail`;
  const job = await enqueueJob(db(), {
    type: `${prefix}.stale-fail`,
    payload: { agentId },
    idempotencyKey: `${prefix}:stale-fail`,
    maxAttempts: 3,
  });
  const [claimed] = await claimJobs({
    workerId: `${prefix}-stale`,
    types: [`${prefix}.stale-fail`],
  });
  expect(claimed.id).toBe(job.id);
  expect(await cancelPendingJobsForAgent(agentId, db(), { includeClaimed: true })).toBe(1);
  const failed = await failJob(claimed.id, `${prefix}-stale`, 'worker still failing');
  expect(failed).toBeNull();
  const [row] = await sqlClient()`SELECT status FROM jobs WHERE id = ${job.id}`;
  expect(row.status).toBe('cancelled');
});

test('pause cancels pending jobs only; stop also cancels claimed jobs', async () => {
  const agentId = `${prefix}-agent-pause`;
  const pending = await enqueueJob(db(), {
    type: `${prefix}.pause-pending`,
    payload: { agentId },
    idempotencyKey: `${prefix}:pause-pending`,
  });
  const claimedJob = await enqueueJob(db(), {
    type: `${prefix}.pause-claimed`,
    payload: { agentId },
    idempotencyKey: `${prefix}:pause-claimed`,
  });
  const [claimed] = await claimJobs({
    workerId: `${prefix}-pause`,
    types: [`${prefix}.pause-claimed`],
  });
  expect(claimed.id).toBe(claimedJob.id);

  expect(await cancelPendingJobsForAgent(agentId, db())).toBe(1);
  const [pendingRow] = await sqlClient()`SELECT status FROM jobs WHERE id = ${pending.id}`;
  const [claimedRow] =
    await sqlClient()`SELECT status, claimed_by FROM jobs WHERE id = ${claimedJob.id}`;
  expect(pendingRow.status).toBe('cancelled');
  expect(claimedRow.status).toBe('claimed');
  expect(claimedRow.claimed_by).toBe(`${prefix}-pause`);

  expect(await cancelPendingJobsForAgent(agentId, db(), { includeClaimed: true })).toBe(1);
  const [stoppedRow] = await sqlClient()`SELECT status FROM jobs WHERE id = ${claimedJob.id}`;
  expect(stoppedRow.status).toBe('cancelled');
});

test('worker drains in-flight work on shutdown', async () => {
  let finished = false;
  await enqueueJob(db(), {
    type: `${prefix}.shutdown`,
    payload: {},
    idempotencyKey: `${prefix}:shutdown`,
  });
  const worker = startJobWorker({
    workerId: `${prefix}-shutdown`,
    pollMs: 20,
    recoveryMs: 1000,
    leaseMs: 5000,
    handlers: {
      [`${prefix}.shutdown`]: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        finished = true;
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  await worker.stop();
  expect(finished).toBe(true);
});
