import type { Tx } from '@/lib/db';
import type { JobRecord } from '@/lib/queue/types';
import type { JobHandler } from '@/lib/queue/worker';
import {
  finalizeFailedFollowUpJob,
  FOLLOW_UP_JOB_TYPE,
  processFollowUpJob,
  reconcileDeadFollowUpJobs,
  skipScheduledFollowUpsForLifecycle,
} from '@/lib/runtime/follow-ups/process';

export interface PendingWorkDefinition {
  type: string;
  handle: JobHandler;
  onDeadLetter: (job: JobRecord, reason: string) => Promise<void>;
  reconcile: () => Promise<unknown>;
  /** Called with the agent lock held after the generic queue cancellation. */
  finalizeLifecycle: (
    tx: Tx,
    change: {
      agentId: string;
      lifecycle: 'paused' | 'stopped';
      cancelledJobIds: readonly string[];
    },
  ) => Promise<void>;
}

export const pendingWork: readonly PendingWorkDefinition[] = [
  {
    type: FOLLOW_UP_JOB_TYPE,
    handle: processFollowUpJob,
    onDeadLetter: (job, reason) =>
      finalizeFailedFollowUpJob(job.payload, reason, { attempts: job.attempts }),
    reconcile: reconcileDeadFollowUpJobs,
    finalizeLifecycle: (tx, { agentId, lifecycle }) =>
      skipScheduledFollowUpsForLifecycle(agentId, lifecycle, tx),
  },
];
