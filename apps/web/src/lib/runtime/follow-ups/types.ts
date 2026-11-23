import { z } from 'zod';

import { parseOffsetBearingDueAt } from '@/lib/runtime/follow-ups/due';

/** Delayed job that executes a follow-up when due. */
export const FOLLOW_UP_JOB_TYPE = 'followup.execute';

export type FollowUpStatus =
  'scheduled' | 'running' | 'completed' | 'cancelled' | 'skipped' | 'failed';

export const pendingFollowUpStatuses = ['scheduled', 'running'] as const;

export type FollowUpSource = 'admin' | 'agent';

export type FollowUpOutcomeKind =
  'executed' | 'reply_received' | 'draft_ready' | 'skipped_lifecycle' | 'cancelled' | 'failed';

export const commitmentGrants = [
  { type: 'commitments.schedule_follow_up', label: 'Schedule follow-up' },
  { type: 'commitments.wait_for_reply', label: 'Wait for reply' },
] as const;

export type CommitmentTool = (typeof commitmentGrants)[number]['type'];

export function isCommitmentTool(type: string): type is CommitmentTool {
  return commitmentGrants.some((grant) => grant.type === type);
}

export interface CommitmentConversation {
  agentId: string;
  channel: string;
  accountId: string | null;
  conversationId: string;
}

export interface CommitmentAnchor extends CommitmentConversation {
  anchorId: string;
}

export const followUpStatusLabels: Record<FollowUpStatus, string> = {
  scheduled: 'Scheduled',
  running: 'Running',
  completed: 'Completed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  failed: 'Failed',
};

export const FOLLOW_UP_ACTIVITY_KINDS = {
  scheduled: 'follow_up.scheduled',
  completed: 'follow_up.completed',
  replyReceived: 'follow_up.reply_received',
  draftReady: 'follow_up.draft_ready',
  skipped: 'follow_up.skipped',
  cancelled: 'follow_up.cancelled',
  failed: 'follow_up.failed',
} as const;

/** Due times must include Z or ±HH:MM so browser-local strings cannot shift on the server. */
export const offsetBearingDueAtSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value, ctx) => {
    const parsed = parseOffsetBearingDueAt(value);
    if (!parsed) {
      ctx.addIssue({
        code: 'custom',
        message: 'Due time must include a timezone offset (Z or ±HH:MM).',
      });
      return z.NEVER;
    }
    return parsed;
  });

export const scheduleFollowUpInputSchema = z.object({
  agentId: z.uuid(),
  subject: z.string().trim().min(1).max(200),
  note: z.string().trim().max(2000).default(''),
  // Date for internal callers; offset-bearing ISO strings from the browser action.
  dueAt: z.union([z.date(), offsetBearingDueAtSchema]),
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
