import { hostname } from 'node:os';

import { closeDb } from '@/lib/db';
import { startJobWorker } from '@/lib/queue/worker';
import { processSimulationJob, SIMULATION_JOB_TYPE } from '@/lib/runtime/execute';

import { workerEnvConfig } from './env';

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

const workerId = config.ORBIT_WORKER_ID ?? `worker-${hostname()}-${process.pid}`;

console.info(`Orbit worker started (${workerId})`);

const worker = startJobWorker({
  workerId,
  handlers: {
    [SIMULATION_JOB_TYPE]: async (job) => {
      await processSimulationJob(job.payload);
    },
  },
  onError: (error) => {
    console.error('Worker job error', error instanceof Error ? error.message : error);
  },
});

const shutdown = async (signal: string) => {
  console.info(`Orbit worker received ${signal}; draining in-flight jobs`);
  await worker.stop();
  await closeDb();
  console.info('Orbit worker stopped');
};

await new Promise<void>((resolve) => {
  const onSignal = (signal: string) => {
    void shutdown(signal).finally(() => resolve());
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
});
