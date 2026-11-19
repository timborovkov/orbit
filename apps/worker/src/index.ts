import { hostname } from 'node:os';
import * as Sentry from '@sentry/bun';

import { closeDb } from '@/lib/db';
import { KNOWLEDGE_JOB_TYPE } from '@/lib/knowledge/types';
import { registerErrorCapture } from '@/lib/observability/errors';
import { sentryInitOptions } from '@/lib/observability/sentry-runtime';
import { startJobWorker } from '@/lib/queue/worker';
import { expireStaleApprovals, reconcileSuspendedApprovals } from '@/lib/runtime/approval-work';
import { fetchReceivedEmail } from '@/lib/runtime/email/provider';
import { processEmailReceiveJob } from '@/lib/runtime/email/receive';
import { EMAIL_DRAFT_JOB, EMAIL_RECEIVE_JOB } from '@/lib/runtime/email/settings';
import {
  finalizeExhaustedSimulationJob,
  processEmailDraftJob,
  processSimulationJob,
  reconcileOrphanedSimulationRuns,
  SIMULATION_JOB_TYPE,
} from '@/lib/runtime/execute';
import {
  finalizeFailedFollowUpJob,
  FOLLOW_UP_JOB_TYPE,
  processFollowUpJob,
} from '@/lib/runtime/follow-ups/process';
import {
  finalizeFailedKnowledgeJob,
  processKnowledgeDocument,
  reconcileDeadKnowledgeJobs,
} from '@/lib/runtime/knowledge/process';
import { resolveKnowledgeEmbedders } from '@/lib/runtime/knowledge/provider';
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

const worker = startJobWorker({
  workerId,
  handlers: {
    [EMAIL_RECEIVE_JOB]: (job, signal) =>
      processEmailReceiveJob(job, workerId, signal, (emailId, fetchSignal) =>
        fetchReceivedEmail(emailId, config.RESEND_API_KEY, fetchSignal),
      ),
    [EMAIL_DRAFT_JOB]: (job, signal) =>
      processEmailDraftJob(job.payload, undefined, signal, {
        jobId: job.id,
        workerId,
      }),
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
    [KNOWLEDGE_JOB_TYPE]: async (job, signal) => {
      try {
        const agentId = typeof job.payload.agentId === 'string' ? job.payload.agentId : undefined;
        if (!agentId) throw new Error('Knowledge job is missing agentId');
        let provider: Awaited<ReturnType<typeof resolveKnowledgeEmbedders>> | undefined;
        await processKnowledgeDocument(
          job.payload,
          async (values, abortSignal) => {
            provider ??= await resolveKnowledgeEmbedders(agentId);
            return provider.embedMany(values, abortSignal);
          },
          signal,
        );
      } catch (error) {
        reportFailure('worker.runtime', jobCorrelation(job), error);
        throw error;
      }
    },
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
    if (job.type === SIMULATION_JOB_TYPE || job.type === EMAIL_DRAFT_JOB) {
      await finalizeExhaustedSimulationJob(job.payload, error);
      return;
    }
    if (job.type === KNOWLEDGE_JOB_TYPE) {
      await finalizeFailedKnowledgeJob(job.payload, error);
      return;
    }
    if (job.type === FOLLOW_UP_JOB_TYPE) {
      await finalizeFailedFollowUpJob(job.payload, error);
    }
  },
  reconcileDeadLetters: async () => {
    await Promise.all([
      reconcileOrphanedSimulationRuns(),
      reconcileDeadKnowledgeJobs(),
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
