import {
  claimJobs,
  completeJob,
  failJob,
  heartbeatJob,
  recoverExpiredLeases,
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
  const inFlight = new Set<Promise<void>>();
  let activeTick: Promise<void> | null = null;
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;
  // Accessor so awaits do not narrow away concurrent stop() flips.
  const hasStopped = () => stopped;

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
          const claimed = await claimJobs({
            workerId: options.workerId,
            types,
            leaseMs,
            limit: slots,
          });
          if (hasStopped()) {
            // Release claims taken after stop began so another worker can retry.
            await Promise.all(
              claimed.map((job) =>
                failJob(job.id, options.workerId, 'Worker shutting down').catch(
                  (error: unknown) => {
                    options.onError?.(error);
                  },
                ),
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
    // Lease-loss / heartbeat failure cancels only this job; shutdown drains without abort.
    const jobCancel = new AbortController();
    const heartbeat = setInterval(
      () => {
        void heartbeatJob(job.id, options.workerId, leaseMs)
          .then((ok) => {
            if (!ok) jobCancel.abort();
          })
          .catch((error: unknown) => {
            options.onError?.(error);
            jobCancel.abort();
          });
      },
      Math.max(1_000, Math.floor(leaseMs / 3)),
    );
    try {
      await handler(job, jobCancel.signal);
      try {
        await completeJob(job.id, options.workerId);
      } catch (error: unknown) {
        options.onError?.(error);
        try {
          await failJob(job.id, options.workerId, 'Failed to mark job completed');
        } catch (failError: unknown) {
          options.onError?.(failError);
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Job failed';
      try {
        await failJob(job.id, options.workerId, message);
      } catch (failError: unknown) {
        options.onError?.(failError);
      }
      options.onError?.(error);
    } finally {
      clearInterval(heartbeat);
    }
  };

  recoveryTimer = setInterval(() => {
    void recoverExpiredLeases().catch((error: unknown) => {
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
