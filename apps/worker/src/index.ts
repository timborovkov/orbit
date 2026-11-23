import { hostname } from 'node:os';

import { migrateDatabase } from '@orbit/migrate';
import * as Sentry from '@sentry/bun';

import { closeDb } from '@/lib/db';
import { KNOWLEDGE_JOB_TYPE, SHARED_KNOWLEDGE_JOB_TYPE } from '@/lib/knowledge/types';
import { registerErrorCapture } from '@/lib/observability/errors';
import { sentryInitOptions } from '@/lib/observability/sentry-runtime';
import type { JobRecord } from '@/lib/queue/types';
import { startJobWorker } from '@/lib/queue/worker';
import { WEB_CRAWL_JOB } from '@/lib/research';
import { expireStaleApprovals, reconcileSuspendedApprovals } from '@/lib/runtime/approval-work';
import { CHANNEL_EVENT_JOB, processChannelEventJob } from '@/lib/runtime/channels/ingest';
import {
  channelJobs,
  channelOutboundJobTypes,
  channelRunJobTypes,
} from '@/lib/runtime/channels/registry';
import {
  EVALUATION_REPLAY_JOB,
  finalizeExhaustedEvaluationReplayJob,
  processEvaluationReplayJob,
  reconcileDeadEvaluationReplayJobs,
} from '@/lib/runtime/evaluation';
import {
  finalizeExhaustedSimulationJob,
  processSimulationJob,
  reconcileOrphanedSimulationRuns,
  SIMULATION_JOB_TYPE,
} from '@/lib/runtime/execute';
import {
  finalizeFailedFollowUpJob,
  FOLLOW_UP_JOB_TYPE,
  processFollowUpJob,
  reconcileDeadFollowUpJobs,
} from '@/lib/runtime/follow-ups/process';
import {
  finalizeFailedKnowledgeJob,
  processKnowledgeDocument,
  reconcileDeadKnowledgeJobs,
} from '@/lib/runtime/knowledge/process';
import {
  resolveKnowledgeEmbedders,
  resolveWorkspaceKnowledgeEmbedders,
} from '@/lib/runtime/knowledge/provider';
import {
  MEMORY_MAINTENANCE_JOB,
  processMemoryMaintenance,
  scheduleMemoryMaintenance,
} from '@/lib/runtime/memory/retention';
import { processMemoryEmbedding } from '@/lib/runtime/memory/store';
import { MEMORY_EMBED_JOB } from '@/lib/runtime/memory/types';
import {
  finalizeExhaustedOutboundJob,
  processOutboundJob,
  reconcileDeadOutboundJobs,
} from '@/lib/runtime/outbound/process';
import { processWebCrawl, reconcileDeadWebCrawls } from '@/lib/runtime/research/crawls';
import { ensureTelemetryContext, reportFailure, shutdownTelemetry } from '@/lib/runtime/telemetry';
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
if (config.X_BEARER_TOKEN) {
  process.env.X_BEARER_TOKEN = config.X_BEARER_TOKEN;
} else {
  delete process.env.X_BEARER_TOKEN;
}

try {
  await migrateDatabase({ databaseUrl: config.DATABASE_URL });
} catch (error) {
  console.error('Orbit worker migration failed; refusing to start queues', error);
  process.exit(1);
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
ensureTelemetryContext();

const workerId = config.ORBIT_WORKER_ID ?? `worker-${hostname()}-${process.pid}`;

console.info(`Orbit worker started (${workerId})`);

function jobCorrelation(job: { id: string; payload: Record<string, unknown> }) {
  return {
    jobId: job.id,
    runId: typeof job.payload.runId === 'string' ? job.payload.runId : undefined,
    agentId: typeof job.payload.agentId === 'string' ? job.payload.agentId : undefined,
    documentId: typeof job.payload.documentId === 'string' ? job.payload.documentId : undefined,
  };
}

const runJobTypes = channelRunJobTypes(SIMULATION_JOB_TYPE);
const outboundJobTypes = channelOutboundJobTypes();
const providerJobs = channelJobs(workerId, [
  ...runJobTypes,
  ...outboundJobTypes,
  CHANNEL_EVENT_JOB,
  EVALUATION_REPLAY_JOB,
  MEMORY_EMBED_JOB,
  MEMORY_MAINTENANCE_JOB,
  KNOWLEDGE_JOB_TYPE,
  SHARED_KNOWLEDGE_JOB_TYPE,
  FOLLOW_UP_JOB_TYPE,
  WEB_CRAWL_JOB,
]);

async function runKnowledgeJob(job: JobRecord, signal: AbortSignal) {
  try {
    const shared = job.type === SHARED_KNOWLEDGE_JOB_TYPE;
    const { agentId, libraryId } = job.payload;
    const resolveProvider = shared
      ? resolveWorkspaceKnowledgeEmbedders
      : typeof agentId === 'string'
        ? () => resolveKnowledgeEmbedders(agentId)
        : undefined;
    if (!resolveProvider || (shared ? typeof libraryId !== 'string' : libraryId !== undefined)) {
      throw new Error('Knowledge job is missing its document owner');
    }
    let provider: Awaited<ReturnType<typeof resolveKnowledgeEmbedders>> | undefined;
    await processKnowledgeDocument(
      job.payload,
      async (values, abortSignal) => {
        provider ??= await resolveProvider();
        return provider.embedMany(values, abortSignal);
      },
      signal,
    );
  } catch (error) {
    reportFailure('worker.runtime', jobCorrelation(job), error);
    throw error;
  }
}

const worker = startJobWorker({
  workerId,
  handlers: {
    ...providerJobs,
    [CHANNEL_EVENT_JOB]: processChannelEventJob,
    ...Object.fromEntries(outboundJobTypes.map((type) => [type, processOutboundJob])),
    ...Object.fromEntries(
      runJobTypes.map((type) => [
        type,
        async (job: JobRecord, signal: AbortSignal) => {
          try {
            await processSimulationJob(job.payload, undefined, signal, {
              jobId: job.id,
              workerId,
              jobType: job.type,
            });
          } catch (error) {
            reportFailure('worker.queue', jobCorrelation(job), error);
            throw error;
          }
        },
      ]),
    ),
    [EVALUATION_REPLAY_JOB]: async (job, signal) => {
      try {
        await processEvaluationReplayJob(job.payload, undefined, signal, {
          jobId: job.id,
          workerId,
          jobType: EVALUATION_REPLAY_JOB,
        });
      } catch (error) {
        reportFailure('worker.queue', jobCorrelation(job), error);
        throw error;
      }
    },
    [MEMORY_MAINTENANCE_JOB]: async (job) => {
      if (typeof job.payload.agentId !== 'string')
        throw new Error('Memory maintenance job is missing its agent');
      await processMemoryMaintenance(job.payload.agentId);
    },
    [MEMORY_EMBED_JOB]: (job, signal) => processMemoryEmbedding(job.payload, signal),
    [KNOWLEDGE_JOB_TYPE]: runKnowledgeJob,
    [SHARED_KNOWLEDGE_JOB_TYPE]: runKnowledgeJob,
    [WEB_CRAWL_JOB]: (job, signal) => processWebCrawl(job, workerId, signal),
    [FOLLOW_UP_JOB_TYPE]: async (job) => {
      try {
        await processFollowUpJob(job.payload, job.attempts);
      } catch (error) {
        reportFailure('worker.runtime', jobCorrelation(job), error);
        throw error;
      }
    },
  },
  onDeadLetter: async (job, error) => {
    reportFailure('worker.dead_letter', jobCorrelation(job), error);
    if (runJobTypes.includes(job.type)) {
      await finalizeExhaustedSimulationJob(job.payload, error);
      return;
    }
    if (job.type === EVALUATION_REPLAY_JOB) {
      await finalizeExhaustedEvaluationReplayJob(job.payload, error);
      return;
    }
    if (outboundJobTypes.includes(job.type)) {
      await finalizeExhaustedOutboundJob(job.payload, error);
      return;
    }
    if (job.type === KNOWLEDGE_JOB_TYPE || job.type === SHARED_KNOWLEDGE_JOB_TYPE) {
      await finalizeFailedKnowledgeJob(job.payload, error);
      return;
    }
    if (job.type === WEB_CRAWL_JOB) await reconcileDeadWebCrawls();
    if (job.type === FOLLOW_UP_JOB_TYPE) {
      await finalizeFailedFollowUpJob(job.payload, error);
    }
  },
  reconcileDeadLetters: async () => {
    await Promise.all([
      reconcileOrphanedSimulationRuns(),
      reconcileDeadEvaluationReplayJobs(),
      reconcileDeadKnowledgeJobs(),
      reconcileDeadFollowUpJobs(),
      reconcileDeadWebCrawls(),
      reconcileDeadOutboundJobs(),
      scheduleMemoryMaintenance(),
      expireStaleApprovals(),
      reconcileSuspendedApprovals(),
    ]);
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
