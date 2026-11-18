import { hostname } from 'node:os';
import * as Sentry from '@sentry/bun';

import { closeDb } from '@/lib/db';
import { registerErrorCapture } from '@/lib/observability/errors';
import { sentryInitOptions } from '@/lib/observability/sentry-runtime';
import { startJobWorker } from '@/lib/queue/worker';
import {
  finalizeExhaustedSimulationJob,
  finalizeOrphanedDeadSimulationRuns,
  processSimulationJob,
  SIMULATION_JOB_TYPE,
} from '@/lib/runtime/execute';
import { reportFailure, shutdownTelemetry } from '@/lib/runtime/telemetry';
import { workerEnvConfig } from '@/lib/worker-env';

const config = workerEnvConfig();
process.env.DATABASE_URL = config.DATABASE_URL;
if (config.ORBIT_ENCRYPTION_KEY) {
  process.env.ORBIT_ENCRYPTION_KEY = config.ORBIT_ENCRYPTION_KEY;
}
if (config.OPENROUTER_API_KEY) {
  process.env.OPENROUTER_API_KEY = config.OPENROUTER_API_KEY;
} else {
  delete process.env.OPENROUTER_API_KEY;
}

const sentry = sentryInitOptions();
if (sentry) {
  Sentry.init(sentry);
  registerErrorCapture(({ message, error, tags }) => {
    Sentry.withScope((scope) => {
      scope.setTags(tags);
      if (error) Sentry.captureException(error);
      else Sentry.captureMessage(message);
    });
  });
}

const workerId = config.ORBIT_WORKER_ID ?? `worker-${hostname()}-${process.pid}`;

console.info(`Orbit worker started (${workerId})`);

function jobCorrelation(job: { id: string; payload: Record<string, unknown> }) {
  return {
    jobId: job.id,
    runId: typeof job.payload.runId === 'string' ? job.payload.runId : undefined,
    agentId: typeof job.payload.agentId === 'string' ? job.payload.agentId : undefined,
  };
}

const worker = startJobWorker({
  workerId,
  handlers: {
    [SIMULATION_JOB_TYPE]: async (job, signal) => {
      try {
        await processSimulationJob(job.payload, undefined, signal, {
          jobId: job.id,
          workerId,
        });
      } catch (error) {
        reportFailure('worker.queue', jobCorrelation(job), error);
        throw error;
      }
    },
  },
  onDeadLetter: async (job, error) => {
    reportFailure('worker.dead_letter', jobCorrelation(job), error);
    if (job.type !== SIMULATION_JOB_TYPE) return;
    await finalizeExhaustedSimulationJob(job.payload, error);
  },
  reconcileDeadLetters: async () => {
    await finalizeOrphanedDeadSimulationRuns();
  },
  onError: (error) => {
    console.error('Worker queue operation failed.');
    reportFailure('worker.queue', {}, error);
  },
});

const shutdown = async (signal: string) => {
  console.info(`Orbit worker received ${signal}; draining in-flight jobs`);
  await worker.stop();
  await closeDb();
  await shutdownTelemetry();
  if (sentry) await Sentry.flush(2000);
  console.info('Orbit worker stopped');
};

await new Promise<void>((resolve) => {
  const onSignal = (signal: string) => {
    void shutdown(signal).finally(() => {
      resolve();
    });
  };
  process.once('SIGINT', () => {
    onSignal('SIGINT');
  });
  process.once('SIGTERM', () => {
    onSignal('SIGTERM');
  });
});
