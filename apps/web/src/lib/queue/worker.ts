import {
  claimJobs,
  completeJob,
  failJob,
  heartbeatJob,
  recoverExpiredLeases,
  releaseClaim,
} from '@/lib/queue/jobs';
import {
  DEFAULT_LEASE_MS,
  DEFAULT_POLL_MS,
  DEFAULT_RECOVERY_MS,
  type JobRecord,
} from '@/lib/queue/types';

type JobHandler = (job: JobRecord, signal: AbortSignal) => Promise<void>;

export interface WorkerOptions {
  workerId: string;
  handlers: Record<string, JobHandler>;
  pollMs?: number;
  recoveryMs?: number;
  leaseMs?: number;
  concurrency?: number;
  onError?: (error: unknown) => void;
  /** Called when failJob dead-letters a job so callers can finalize linked domain state. */
  onDeadLetter?: (job: JobRecord, error: string) => Promise<void>;
  /**
   * Durable domain reconcile for dead jobs whose onDeadLetter callback previously failed.
   * Invoked on every recovery tick after lease recovery.
   */
  reconcileDeadLetters?: () => Promise<void>;
  /** Optional test seams; production uses the Postgres-backed helpers. */
  claimJobs?: typeof claimJobs;
  completeJob?: typeof completeJob;
  failJob?: typeof failJob;
  releaseClaim?: typeof releaseClaim;
  recoverExpiredLeases?: typeof recoverExpiredLeases;
  /** Must return false only for confirmed lease loss; transport errors should throw. */
  heartbeat?: (jobId: string, workerId: string, leaseMs?: number) => Promise<boolean>;
  /** Override heartbeat cadence (tests); production uses max(1s, lease/3). */
  heartbeatIntervalMs?: number;
}

/**
 * Polling worker with lease heartbeats, expired-lease recovery and SIGTERM drain.
 * LISTEN/NOTIFY is intentionally omitted; polling is the delivery mechanism.
 * Shutdown waits for an in-flight claim poll, then drains handlers without aborting them.
 */
export function startJobWorker(options: WorkerOptions) {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const recoveryMs = options.recoveryMs ?? DEFAULT_RECOVERY_MS;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const concurrency = options.concurrency ?? 1;
  const types = Object.keys(options.handlers);
  const claim = options.claimJobs ?? claimJobs;
  const complete = options.completeJob ?? completeJob;
  const fail = options.failJob ?? failJob;
  const release = options.releaseClaim ?? releaseClaim;
  const recover = options.recoverExpiredLeases ?? recoverExpiredLeases;
  const beat = options.heartbeat ?? heartbeatJob;
  const inFlight = new Set<Promise<void>>();
  let activeTick: Promise<void> | null = null;
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;
  // Accessor so awaits do not narrow away concurrent stop() flips.
  const hasStopped = () => stopped;

  const notifyDeadLetter = async (job: JobRecord, errorMessage: string) => {
    if (!options.onDeadLetter) return;
    try {
      await options.onDeadLetter(job, errorMessage);
    } catch (error: unknown) {
      options.onError?.(error);
    }
  };

  const schedulePoll = (delay = pollMs) => {
    if (hasStopped()) return;
    pollTimer = setTimeout(() => {
      void tick();
    }, delay);
  };

  const tick = async () => {
    if (hasStopped()) return;
    const run = (async () => {
      try {
        const slots = concurrency - inFlight.size;
        if (slots > 0) {
          const claimed = await claim({
            workerId: options.workerId,
            types,
            leaseMs,
            limit: slots,
          });
          if (hasStopped()) {
            // Release unexecuted claims without burning attempts or dead-lettering.
            await Promise.all(
              claimed.map((job) =>
                release(job.id, options.workerId).catch((error: unknown) => {
                  options.onError?.(error);
                }),
              ),
            );
            return;
          }
          for (const job of claimed) {
            const work = runClaimed(job)
              .catch((error: unknown) => {
                options.onError?.(error);
              })
              .finally(() => inFlight.delete(work));
            inFlight.add(work);
          }
        }
      } catch (error) {
        options.onError?.(error);
      }
    })();
    activeTick = run;
    try {
      await run;
    } finally {
      if (activeTick === run) activeTick = null;
    }
    schedulePoll(inFlight.size >= concurrency ? pollMs : Math.min(pollMs, 250));
  };

  const runClaimed = async (job: JobRecord) => {
    const handler = options.handlers[job.type];
    // Confirmed lease loss cancels only this job; shutdown drains without abort.
    // Transient heartbeat transport errors are reported but do not abort — aborting would
    // mark the simulation failed and complete the job, burning remaining retries.
    const jobCancel = new AbortController();
    const heartbeat = setInterval(
      () => {
        void beat(job.id, options.workerId, leaseMs)
          .then((ok) => {
            if (!ok) jobCancel.abort();
          })
          .catch((error: unknown) => {
            options.onError?.(error);
          });
      },
      options.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(leaseMs / 3)),
    );
    const deadLetter = async (errorMessage: string) => {
      try {
        const failed = await fail(job.id, options.workerId, errorMessage);
        if (failed?.status === 'dead') {
          await notifyDeadLetter(job, errorMessage);
        }
      } catch (failError: unknown) {
        options.onError?.(failError);
      }
    };

    try {
      await handler(job, jobCancel.signal);
      try {
        await complete(job.id, options.workerId);
      } catch (error: unknown) {
        options.onError?.(error);
        await deadLetter('Failed to mark job completed');
      }
    } catch (error: unknown) {
      const message = 'Worker could not process the job';
      await deadLetter(message);
      options.onError?.(error);
    } finally {
      clearInterval(heartbeat);
    }
  };

  recoveryTimer = setInterval(() => {
    void recover()
      .then(async (recovered) => {
        await Promise.all(
          recovered
            .filter((job) => job.status === 'dead')
            .map((job) =>
              notifyDeadLetter(job, job.lastError ?? 'Lease expired after max attempts'),
            ),
        );
        if (options.reconcileDeadLetters) {
          try {
            await options.reconcileDeadLetters();
          } catch (error: unknown) {
            options.onError?.(error);
          }
        }
      })
      .catch((error: unknown) => {
        options.onError?.(error);
      });
  }, recoveryMs);

  schedulePoll(0);

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    clearInterval(recoveryTimer);
    if (activeTick) await activeTick;
    // Drain in-flight inference; do not abort so runs can finish or stay retryable.
    await Promise.allSettled([...inFlight]);
  };

  return { stop, inFlight };
}
