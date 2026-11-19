import { z } from 'zod';

/** Delayed job that executes an admin-scheduled follow-up when due. */
export const FOLLOW_UP_JOB_TYPE = 'followup.execute';

export type FollowUpStatus =
  'scheduled' | 'running' | 'completed' | 'cancelled' | 'skipped' | 'failed';

export type FollowUpSource = 'admin' | 'agent';

export type FollowUpOutcomeKind = 'executed' | 'skipped_lifecycle' | 'cancelled' | 'failed';

export const followUpStatusLabels: Record<FollowUpStatus, string> = {
  scheduled: 'Scheduled',
  running: 'Running',
  completed: 'Completed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  failed: 'Failed',
};

export const FOLLOW_UP_ACTIVITY_KINDS = {
  completed: 'follow_up.completed',
  skipped: 'follow_up.skipped',
  cancelled: 'follow_up.cancelled',
  failed: 'follow_up.failed',
} as const;

export const scheduleFollowUpInputSchema = z.object({
  agentId: z.uuid(),
  subject: z.string().trim().min(1).max(200),
  note: z.string().trim().max(2000).default(''),
  dueAt: z.coerce.date(),
});

export const followUpJobPayloadSchema = z.object({
  followUpId: z.uuid(),
  agentId: z.uuid(),
});

/**
 * Lifecycle policy for due follow-ups:
 * - paused / stopped agents do not execute.
 * - When a pending follow-up job is cancelled on pause/stop, or a claimed job
 *   observes a non-executable lifecycle, the commitment is skip-and-record:
 *   status → skipped, outcome_kind → skipped_lifecycle, and an activity event
 *   is written. It does not defer until resume.
 */
export const FOLLOW_UP_LIFECYCLE_POLICY =
  'skip-and-record: paused and stopped agents never execute due follow-ups; the commitment is marked skipped with a lifecycle outcome.';
