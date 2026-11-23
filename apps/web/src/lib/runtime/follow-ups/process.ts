import { and, eq, gt, inArray, sql } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import { canAcceptBackgroundWork } from '@/lib/lifecycle';
import { authorizeAction, loadPolicyContext } from '@/lib/policy/gateway';
import { activeJobClaim } from '@/lib/queue/jobs';
import type { JobClaimIdentity, JobRecord } from '@/lib/queue/types';
import { lockApprovalAgent } from '@/lib/runtime/approval-work';
import { channelAction, channelAdapter } from '@/lib/runtime/channels/registry';
import {
  cancelCommitmentJobs,
  commitmentClock,
  type FollowUp,
  recordFollowUpOutcome,
  recordFollowUpOutcomes,
} from '@/lib/runtime/follow-ups/state';
import {
  FOLLOW_UP_JOB_TYPE,
  followUpJobPayloadSchema,
  pendingFollowUpStatuses,
} from '@/lib/runtime/follow-ups/types';
import { draftAnswerFromResult, type SimulationResult } from '@/lib/runtime/simulation';
import { followUps, jobs, runs } from '@/lib/schema';

async function prepareDraft(tx: Tx, row: FollowUp) {
  const adapter = channelAdapter(row.channel);
  const draft = adapter?.followUp;
  if (
    !adapter ||
    adapter.run.mode !== 'draft' ||
    !draft ||
    !row.anchorId ||
    !row.conversationId ||
    !row.channel
  )
    return;
  const action = channelAction(draft.actionType);
  if (action?.channel !== adapter.id || !action.action.alwaysRequiresApproval) return;
  const prepared = await draft.prepare(
    tx,
    {
      agentId: row.agentId,
      channel: row.channel,
      accountId: row.accountId,
      conversationId: row.conversationId,
      anchorId: row.anchorId,
    },
    row,
  );
  if (prepared) return { adapter, actionType: draft.actionType, ...prepared };
}

async function skipCommitments(
  tx: Tx,
  agentId: string,
  rows: FollowUp[],
  lifecycle: 'paused' | 'stopped',
  now: Date,
) {
  const reason = `Agent is ${lifecycle}.`;
  await cancelCommitmentJobs(tx, agentId, rows, reason, now);
  await recordFollowUpOutcomes(
    tx,
    agentId,
    rows.map(({ id }) => id),
    'skipped_lifecycle',
    reason,
    now,
    {
      cancelledAt: now,
      cancelledBy: 'system:lifecycle',
      cancelReason: reason,
    },
  );
}

interface DeadlineResult {
  recorded: boolean;
  status: string;
  deferUntil?: Date;
}

/** Intake, timers, run completion and cancellation all serialize on the agent row. */
export async function finalizeFollowUpExecution(
  followUpId: string,
  options: { attempts?: number; agentId?: string; store?: Tx; job?: JobRecord } = {},
): Promise<DeadlineResult> {
  const run = async (tx: Tx): Promise<DeadlineResult> => {
    const agentId =
      options.agentId ??
      (
        await tx
          .select({ agentId: followUps.agentId })
          .from(followUps)
          .where(eq(followUps.id, followUpId))
      ).at(0)?.agentId;
    const agent = agentId && (await lockApprovalAgent(tx, agentId));
    if (!agent) return { recorded: false, status: 'missing' };
    const [row] = await tx
      .select()
      .from(followUps)
      .where(and(eq(followUps.id, followUpId), eq(followUps.agentId, agent.id)));
    if (!row || (options.job && row.jobId !== options.job.id))
      return { recorded: false, status: 'missing' };
    if (row.status !== 'scheduled') return { recorded: false, status: row.status };

    if (options.job) {
      const [job] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            activeJobClaim(options.job.id, options.job.claimedBy ?? '', options.job),
            eq(jobs.type, FOLLOW_UP_JOB_TYPE),
          ),
        )
        .for('update');
      if (!job) return { recorded: false, status: 'lost_claim' };
    }

    const now = await commitmentClock(tx);
    if (agent.lifecycle === 'paused' || agent.lifecycle === 'stopped') {
      await skipCommitments(tx, row.agentId, [row], agent.lifecycle, now);
      return { recorded: true, status: 'skipped' };
    }
    if (row.dueAt > now) {
      return { recorded: false, status: 'scheduled', deferUntil: row.dueAt };
    }
    const started = { attempts: options.attempts ?? row.attempts + 1, startedAt: now };
    if (!row.channel) {
      const note = row.note ? ` Note: ${row.note}` : '';
      await recordFollowUpOutcome(
        tx,
        row,
        'executed',
        `Follow-up completed: ${row.subject}.${note} Internal outcome only; no external actions were taken.`,
        now,
        started,
      );
      return { recorded: true, status: 'completed' };
    }

    const draft = await prepareDraft(tx, row);
    const [origin] = row.originatingRunId
      ? await tx
          .select({ configurationId: runs.configurationId })
          .from(runs)
          .where(and(eq(runs.agentId, row.agentId), eq(runs.id, row.originatingRunId)))
      : [];
    if (!draft || !origin) {
      await recordFollowUpOutcome(
        tx,
        row,
        'failed',
        'The saved conversation is unavailable for drafting.',
        now,
        started,
      );
      return { recorded: true, status: 'failed' };
    }

    const { admitRun } = await import('@/lib/runtime/execute');
    const admitted = await admitRun(tx, agent, {
      actor: 'system:follow-up',
      channel: draft.adapter.id,
      origin: draft.adapter.legacyOrigin ?? 'channel',
      configurationId: origin.configurationId,
      input: draft.input,
      recipients: draft.recipients,
    });
    if ('error' in admitted) {
      if (admitted.waitForCapacity) {
        return {
          recorded: false,
          status: 'scheduled',
          deferUntil: new Date(now.getTime() + 5_000),
        };
      }
      await recordFollowUpOutcome(
        tx,
        row,
        'failed',
        admitted.error ?? 'The draft run could not be queued.',
        now,
        started,
      );
      return { recorded: true, status: 'failed' };
    }
    await tx
      .update(followUps)
      .set({
        ...started,
        status: 'running',
        draftRunId: admitted.runId,
        updatedAt: now,
      })
      .where(eq(followUps.id, row.id));
    return { recorded: false, status: 'running' };
  };

  return options.store ? run(options.store) : db().transaction(run);
}

export async function processFollowUpJob(job: JobRecord, signal: AbortSignal) {
  signal.throwIfAborted();
  const { followUpId, agentId } = followUpJobPayloadSchema.parse(job.payload);
  const { deferUntil } = await finalizeFollowUpExecution(followUpId, {
    agentId,
    attempts: job.attempts,
    job,
  });
  if (deferUntil) return { deferUntil };
}

export async function skipScheduledFollowUpsForLifecycle(
  agentId: string,
  next: 'paused' | 'stopped',
  tx: Tx,
) {
  const [rows, now] = await Promise.all([
    tx
      .select()
      .from(followUps)
      .where(
        and(eq(followUps.agentId, agentId), inArray(followUps.status, pendingFollowUpStatuses)),
      ),
    commitmentClock(tx),
  ]);
  if (rows.length) await skipCommitments(tx, agentId, rows, next, now);
}

/** Publish the approval and finish the commitment in the owned run's finalization transaction. */
export async function finalizeCommitmentDraft(
  tx: Tx,
  run: typeof runs.$inferSelect,
  executionToken: string,
  result: SimulationResult,
  claim?: { jobId: string; workerId: string; lease?: JobClaimIdentity },
) {
  const agent = await lockApprovalAgent(tx, run.agentId);
  if (!agent || !canAcceptBackgroundWork(agent.lifecycle)) return false;
  const [row] = await tx
    .select()
    .from(followUps)
    .where(and(eq(followUps.agentId, agent.id), eq(followUps.draftRunId, run.id)));
  if (row?.status !== 'running') return false;
  const now = await commitmentClock(tx);
  if (claim) {
    const [ownedJob] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(activeJobClaim(claim.jobId, claim.workerId, claim.lease))
      .for('update');
    if (!ownedJob) return false;
  }
  const [owned] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.id, run.id),
        eq(runs.executionToken, executionToken),
        eq(runs.status, 'running'),
        gt(runs.expiresAt, now),
      ),
    )
    .for('update');
  if (!owned) return false;

  const answer = draftAnswerFromResult(result)?.answer.trim();
  const draft = answer && !result.error ? await prepareDraft(tx, row) : null;
  const policy = draft && (await loadPolicyContext(run.agentId, run.actor, run.id, tx));
  if (!draft || !policy || !answer) {
    await recordFollowUpOutcome(
      tx,
      row,
      'failed',
      result.error ?? 'The run did not produce a reviewable follow-up draft.',
      now,
    );
    return true;
  }
  const decision = await authorizeAction(
    policy,
    {
      type: draft.actionType,
      recipients: draft.recipients,
      payload: { ...draft.payload, draft: answer, reason: 'Scheduled conversation follow-up' },
      idempotencyKey: `followup:${row.id}:draft`,
      executionToken,
    },
    tx,
  );
  if (decision.decision === 'needs-approval') {
    await recordFollowUpOutcome(
      tx,
      row,
      'draft_ready',
      'A follow-up draft is ready for administrator review.',
      now,
      {
        approvalIntentId: decision.intentId,
      },
    );
  } else {
    await recordFollowUpOutcome(tx, row, 'failed', decision.reasons.join(' '), now);
  }
  return true;
}

export async function finalizeFailedFollowUpJob(
  payload: Record<string, unknown>,
  error: string,
  options: { attempts?: number } = {},
) {
  const parsed = followUpJobPayloadSchema.safeParse(payload);
  if (!parsed.success) return;
  const { agentId, followUpId } = parsed.data;
  await db().transaction(async (tx) => {
    if (!(await lockApprovalAgent(tx, agentId))) return;
    const [row] = await tx
      .select()
      .from(followUps)
      .where(and(eq(followUps.id, followUpId), eq(followUps.agentId, agentId)));
    if (row?.status !== 'scheduled') return;
    const [job] = row.jobId
      ? await tx
          .select({ attempts: jobs.attempts, status: jobs.status })
          .from(jobs)
          .where(eq(jobs.id, row.jobId))
      : [];
    if (job?.status !== 'dead') return;
    await recordFollowUpOutcome(
      tx,
      row,
      'failed',
      error.slice(0, 2000),
      await commitmentClock(tx),
      {
        attempts: options.attempts ?? job.attempts,
      },
    );
  });
}

export async function reconcileDeadFollowUpJobs() {
  const abandoned = await db().execute<{
    id: string;
    agent_id: string;
    attempts: number;
    last_error: string;
  }>(sql`
    SELECT f.id, f.agent_id, j.attempts,
      coalesce(j.last_error, 'The worker could not finish the follow-up.') AS last_error
    FROM follow_ups AS f
    INNER JOIN jobs AS j ON j.id = f.job_id
    WHERE f.status = 'scheduled' AND j.type = ${FOLLOW_UP_JOB_TYPE} AND j.status = 'dead'
  `);
  for (const row of abandoned) {
    await finalizeFailedFollowUpJob({ followUpId: row.id, agentId: row.agent_id }, row.last_error, {
      attempts: row.attempts,
    });
  }

  const abandonedDrafts = await db().execute<{ id: string; agentId: string }>(sql`
    SELECT f.id, f.agent_id AS "agentId"
    FROM follow_ups f
    LEFT JOIN simulation_runs r ON r.id = f.draft_run_id
    WHERE f.status = 'running' AND f.channel IS NOT NULL
      AND (r.id IS NULL OR r.status IN ('failed', 'interrupted', 'completed'))
  `);
  for (const draft of abandonedDrafts) {
    await db().transaction(async (tx) => {
      if (!(await lockApprovalAgent(tx, draft.agentId))) return;
      const [row] = await tx
        .select()
        .from(followUps)
        .where(and(eq(followUps.id, draft.id), eq(followUps.agentId, draft.agentId)));
      if (row?.status === 'running') {
        await recordFollowUpOutcome(
          tx,
          row,
          'failed',
          'The draft run ended without a reviewable follow-up.',
          await commitmentClock(tx),
        );
      }
    });
  }
  return abandoned.length + abandonedDrafts.length;
}

export { FOLLOW_UP_JOB_TYPE };
