import { expect, test } from 'bun:test';

import {
  backoffMs,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_POLL_MS,
  DEFAULT_RECOVERY_MS,
  type EnqueueInput,
  type JobRecord,
} from '@/lib/queue/types';

/** In-memory stand-in for PostgreSQL job rows — exercises queue state transitions without I/O. */
class FakeJobStore {
  private rows = new Map<string, JobRecord>();
  private seq = 0;

  enqueue(input: EnqueueInput): JobRecord {
    if (input.idempotencyKey) {
      for (const row of this.rows.values()) {
        if (row.idempotencyKey === input.idempotencyKey) return row;
      }
    }
    const now = new Date();
    const id = `fake-${++this.seq}`;
    const row: JobRecord = {
      id,
      type: input.type,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      availableAt: input.availableAt ?? now,
      claimedAt: null,
      claimExpiresAt: null,
      claimedBy: null,
      finishedAt: null,
      lastError: null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, row);
    return row;
  }

  claim(workerId: string, type: string, leaseMs = DEFAULT_LEASE_MS, now = new Date()): JobRecord[] {
    for (const row of this.rows.values()) {
      if (row.type !== type || row.status !== 'pending') continue;
      if (row.availableAt > now) continue;
      row.status = 'claimed';
      row.attempts += 1;
      row.claimedAt = now;
      row.claimExpiresAt = new Date(now.getTime() + leaseMs);
      row.claimedBy = workerId;
      row.updatedAt = now;
      return [row];
    }
    return [];
  }

  /** Two concurrent claimants: only the first wins (SKIP LOCKED analogue). */
  claimExclusive(
    workers: [string, string],
    type: string,
    leaseMs = DEFAULT_LEASE_MS,
  ): [JobRecord[], JobRecord[]] {
    const first = this.claim(workers[0], type, leaseMs);
    const second = this.claim(workers[1], type, leaseMs);
    return [first, second];
  }

  recoverExpired(now = new Date()): number {
    let count = 0;
    for (const row of this.rows.values()) {
      if (row.status !== 'claimed' || !row.claimExpiresAt || row.claimExpiresAt > now) continue;
      if (row.attempts >= row.maxAttempts) {
        row.status = 'dead';
        row.finishedAt = now;
        row.lastError = row.lastError ?? 'Lease expired after max attempts';
      } else {
        row.status = 'pending';
        row.availableAt = now;
      }
      row.claimedAt = null;
      row.claimExpiresAt = null;
      row.claimedBy = null;
      row.updatedAt = now;
      count += 1;
    }
    return count;
  }

  fail(id: string, workerId: string, error: string, now = new Date()): JobRecord | null {
    const row = this.rows.get(id);
    if (!row || row.claimedBy !== workerId || row.status !== 'claimed') return null;
    if (row.attempts >= row.maxAttempts) {
      row.status = 'dead';
      row.finishedAt = now;
      row.lastError = error;
      row.claimedAt = null;
      row.claimExpiresAt = null;
      row.claimedBy = null;
    } else {
      row.status = 'pending';
      row.lastError = error;
      row.availableAt = new Date(now.getTime() + backoffMs(row.attempts));
      row.claimedAt = null;
      row.claimExpiresAt = null;
      row.claimedBy = null;
    }
    row.updatedAt = now;
    return { ...row };
  }

  complete(id: string, workerId: string, now = new Date()): boolean {
    const row = this.rows.get(id);
    if (!row || row.claimedBy !== workerId || row.status !== 'claimed') return false;
    row.status = 'completed';
    row.finishedAt = now;
    row.claimedAt = null;
    row.claimExpiresAt = null;
    row.claimedBy = null;
    row.updatedAt = now;
    return true;
  }

  get(id: string) {
    return this.rows.get(id);
  }
}

test('backoff grows exponentially and stays within the one-minute cap', () => {
  const original = Math.random;
  Math.random = () => 0;
  try {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
    expect(backoffMs(10)).toBe(60_000);
  } finally {
    Math.random = original;
  }
  const withJitter = backoffMs(1);
  expect(withJitter).toBeGreaterThanOrEqual(1_000);
  expect(withJitter).toBeLessThan(1_250);
});

test('queue defaults match the polling worker contract', () => {
  expect(DEFAULT_LEASE_MS).toBe(30_000);
  expect(DEFAULT_MAX_ATTEMPTS).toBe(5);
  expect(DEFAULT_POLL_MS).toBe(1_000);
  expect(DEFAULT_RECOVERY_MS).toBe(5_000);
});

test('fake store: exclusive claim, lease recovery, retry, dead-letter and idempotency', () => {
  const store = new FakeJobStore();
  const job = store.enqueue({
    type: 'sim',
    payload: { n: 1 },
    idempotencyKey: 'once',
    maxAttempts: 2,
  });
  expect(store.enqueue({ type: 'sim', payload: { n: 2 }, idempotencyKey: 'once' }).id).toBe(job.id);

  const [a, b] = store.claimExclusive(['w1', 'w2'], 'sim', 1);
  expect([...a, ...b]).toHaveLength(1);
  const claimed = a[0] ?? b[0]!;
  expect(claimed.id).toBe(job.id);

  claimed.claimExpiresAt = new Date(0);
  expect(store.recoverExpired(new Date())).toBe(1);
  expect(store.get(job.id)?.status).toBe('pending');

  const [first] = store.claim('w3', 'sim');
  expect(first.attempts).toBe(2);
  // Reset attempts to mirror a fresh job's first failure path after recovery demo.
  first.attempts = 1;
  expect(store.fail(first.id, 'w3', 'boom')?.status).toBe('pending');

  first.availableAt = new Date(0);
  const [last] = store.claim('w4', 'sim');
  expect(store.fail(last.id, 'w4', 'boom again')?.status).toBe('dead');
  expect(store.get(job.id)?.status).toBe('dead');
});

test('fake store: exhausted lease recovery dead-letters instead of retrying', () => {
  const store = new FakeJobStore();
  const job = store.enqueue({
    type: 'once',
    payload: {},
    idempotencyKey: 'once-lease',
    maxAttempts: 1,
  });
  const [claimed] = store.claim('w', 'once', 1);
  expect(claimed.attempts).toBe(1);
  claimed.claimExpiresAt = new Date(0);
  expect(store.recoverExpired()).toBe(1);
  expect(store.get(job.id)?.status).toBe('dead');
  expect(store.claim('w2', 'once')).toHaveLength(0);
});

test('fake store: worker drain completes in-flight work before stop resolves', async () => {
  const store = new FakeJobStore();
  store.enqueue({ type: 'drain', payload: {}, idempotencyKey: 'drain' });
  const [job] = store.claim('drain-worker', 'drain');
  let finished = false;
  const work = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    finished = true;
    expect(store.complete(job.id, 'drain-worker')).toBe(true);
  })();
  await work;
  expect(finished).toBe(true);
  expect(store.get(job.id)?.status).toBe('completed');
});

test('transient heartbeat errors do not abort; confirmed lease loss does', async () => {
  const { startJobWorker } = await import('@/lib/queue/worker');
  const store = new FakeJobStore();
  store.enqueue({ type: 'hb', payload: {}, idempotencyKey: 'hb-1' });

  let heartbeatCalls = 0;
  let sawAbort = false;
  const errors: unknown[] = [];

  const worker = startJobWorker({
    workerId: 'w-hb',
    pollMs: 15,
    recoveryMs: 60_000,
    leaseMs: 3_000,
    heartbeatIntervalMs: 20,
    onError: (error) => errors.push(error),
    claimJobs: async () => store.claim('w-hb', 'hb', 3_000),
    completeJob: async (id, workerId) => {
      expect(store.complete(id, workerId)).toBe(true);
    },
    failJob: async (id, workerId, error) => store.fail(id, workerId, error),
    recoverExpiredLeases: async () => store.recoverExpired(),
    heartbeat: async () => {
      heartbeatCalls += 1;
      if (heartbeatCalls === 1) throw new Error('transient db blip');
      return true;
    },
    handlers: {
      hb: async (_job, signal) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 90));
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 140));
  await worker.stop();
  expect(store.get('fake-1')?.status).toBe('completed');
  expect(sawAbort).toBe(false);
  expect(errors.some((e) => e instanceof Error && e.message === 'transient db blip')).toBe(true);

  // Confirmed lease loss still aborts the in-flight handler.
  store.enqueue({ type: 'lost', payload: {}, idempotencyKey: 'hb-2' });
  let lostAbort = false;
  const lostWorker = startJobWorker({
    workerId: 'w-lost',
    pollMs: 15,
    recoveryMs: 60_000,
    leaseMs: 3_000,
    heartbeatIntervalMs: 20,
    claimJobs: async () => store.claim('w-lost', 'lost', 3_000),
    completeJob: async (id, workerId) => {
      store.complete(id, workerId);
    },
    failJob: async (id, workerId, error) => store.fail(id, workerId, error),
    recoverExpiredLeases: async () => 0,
    heartbeat: async () => false,
    handlers: {
      lost: async (_job, signal) => {
        signal.addEventListener('abort', () => {
          lostAbort = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 80));
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  await lostWorker.stop();
  expect(lostAbort).toBe(true);
});

test('dead-lettered jobs invoke onDeadLetter for domain finalization', async () => {
  const { startJobWorker } = await import('@/lib/queue/worker');
  const store = new FakeJobStore();
  store.enqueue({
    type: 'once',
    payload: { runId: 'run-1' },
    idempotencyKey: 'dl-1',
    maxAttempts: 1,
  });
  const deadLetters: { id: string; error: string }[] = [];

  const worker = startJobWorker({
    workerId: 'w-dl',
    pollMs: 15,
    recoveryMs: 60_000,
    leaseMs: 3_000,
    claimJobs: async () => store.claim('w-dl', 'once', 3_000),
    completeJob: async () => {
      throw new Error('should not complete');
    },
    failJob: async (id, workerId, error) => store.fail(id, workerId, error),
    recoverExpiredLeases: async () => 0,
    heartbeat: async () => true,
    onDeadLetter: async (job, error) => {
      deadLetters.push({ id: job.id, error });
    },
    handlers: {
      once: async () => {
        throw new Error('quota reservation db blip');
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  await worker.stop();
  expect(store.get('fake-1')?.status).toBe('dead');
  expect(deadLetters).toEqual([{ id: 'fake-1', error: 'quota reservation db blip' }]);
});
