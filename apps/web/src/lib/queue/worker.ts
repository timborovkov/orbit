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

export type JobHandler = (job: JobRecord, signal: AbortSignal) => Promise<void>;

export type WorkerOptions = {
  workerId: string;
  handlers: Record<string, JobHandler>;
  pollMs?: number;
  recoveryMs?: number;
  leaseMs?: number;
  concurrency?: number;
  onError?: (error: unknown) => void;
};

/**
 * Polling worker with lease heartbeats, expired-lease recovery and SIGTERM drain.
 * LISTEN/NOTIFY is intentionally omitted; polling is the delivery mechanism.
 */
export function startJobWorker(options: WorkerOptions) {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const recoveryMs = options.recoveryMs ?? DEFAULT_RECOVERY_MS;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const concurrency = options.concurrency ?? 1;
  const types = Object.keys(options.handlers);
  const abort = new AbortController();
  const inFlight = new Set<Promise<void>>();
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;

  const schedulePoll = (delay = pollMs) => {
    if (stopped) return;
    pollTimer = setTimeout(() => {
      void tick();
    }, delay);
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const slots = concurrency - inFlight.size;
      if (slots > 0) {
        const claimed = await claimJobs({
          workerId: options.workerId,
          types,
          leaseMs,
          limit: slots,
        });
        for (const job of claimed) {
          const work = runClaimed(job).finally(() => inFlight.delete(work));
          inFlight.add(work);
        }
      }
    } catch (error) {
      options.onError?.(error);
    }
    schedulePoll(inFlight.size >= concurrency ? pollMs : Math.min(pollMs, 250));
  };

  const runClaimed = async (job: JobRecord) => {
    const handler = options.handlers[job.type];
    if (!handler) {
      await failJob(job.id, options.workerId, `No handler for job type ${job.type}`);
      return;
    }
    const heartbeat = setInterval(() => {
      void heartbeatJob(job.id, options.workerId, leaseMs).then((ok) => {
        if (!ok) abort.abort();
      });
    }, Math.max(1_000, Math.floor(leaseMs / 3)));
    try {
      await handler(job, abort.signal);
      if (!stopped) await completeJob(job.id, options.workerId);
      else await failJob(job.id, options.workerId, 'Worker shutting down');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Job failed';
      await failJob(job.id, options.workerId, message);
      options.onError?.(error);
    } finally {
      clearInterval(heartbeat);
    }
  };

  recoveryTimer = setInterval(() => {
    void recoverExpiredLeases().catch((error) => options.onError?.(error));
  }, recoveryMs);

  schedulePoll(0);

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    abort.abort();
    if (pollTimer) clearTimeout(pollTimer);
    if (recoveryTimer) clearInterval(recoveryTimer);
    await Promise.allSettled([...inFlight]);
  };

  return { stop, inFlight };
}
