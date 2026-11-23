import { agentActivityEvents, followUps, jobs } from '@/lib/schema';
import { demoTime } from '@/lib/seed/clock';
import {
  DEMO_ACTIVITY,
  DEMO_ACTOR,
  DEMO_AGENTS,
  DEMO_EMAIL,
  DEMO_FOLLOW_UP_JOBS,
  DEMO_FOLLOW_UPS,
} from '@/lib/seed/ids';
import type { SeedModule } from '@/lib/seed/types';

export const followUpsModule: SeedModule = {
  name: 'follow-ups',
  async apply({ tx, now }) {
    const johnDue = demoTime(now, 2 * 24 * 60 * 60 * 1000);
    const sarahDue = demoTime(now, -3 * 60 * 60 * 1000);
    const sarahFinished = demoTime(now, -3 * 60 * 60 * 1000 + 5_000);

    await tx
      .insert(jobs)
      .values({
        id: DEMO_FOLLOW_UP_JOBS.johnScheduled,
        type: 'followup.execute',
        payload: {
          followUpId: DEMO_FOLLOW_UPS.johnScheduled,
          agentId: DEMO_AGENTS.john,
        },
        status: 'pending',
        attempts: 0,
        maxAttempts: 5,
        availableAt: johnDue,
        idempotencyKey: `orbit-demo:followup:${DEMO_FOLLOW_UPS.johnScheduled}`,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: jobs.id,
        set: {
          type: 'followup.execute',
          payload: {
            followUpId: DEMO_FOLLOW_UPS.johnScheduled,
            agentId: DEMO_AGENTS.john,
          },
          status: 'pending',
          availableAt: johnDue,
          idempotencyKey: `orbit-demo:followup:${DEMO_FOLLOW_UPS.johnScheduled}`,
          updatedAt: now,
        },
      });

    await tx
      .insert(jobs)
      .values({
        id: DEMO_FOLLOW_UP_JOBS.sarahCompleted,
        type: 'followup.execute',
        payload: {
          followUpId: DEMO_FOLLOW_UPS.sarahCompleted,
          agentId: DEMO_AGENTS.sarah,
        },
        status: 'completed',
        attempts: 1,
        maxAttempts: 5,
        availableAt: sarahDue,
        claimedAt: sarahDue,
        finishedAt: sarahFinished,
        claimedBy: 'demo-worker',
        idempotencyKey: `orbit-demo:followup:${DEMO_FOLLOW_UPS.sarahCompleted}`,
        createdAt: sarahDue,
        updatedAt: sarahFinished,
      })
      .onConflictDoUpdate({
        target: jobs.id,
        set: {
          type: 'followup.execute',
          status: 'completed',
          attempts: 1,
          finishedAt: sarahFinished,
          idempotencyKey: `orbit-demo:followup:${DEMO_FOLLOW_UPS.sarahCompleted}`,
          updatedAt: sarahFinished,
        },
      });

    await tx
      .insert(followUps)
      .values({
        id: DEMO_FOLLOW_UPS.johnScheduled,
        agentId: DEMO_AGENTS.john,
        source: 'admin',
        createdBy: DEMO_ACTOR,
        subject: 'Confirm discovery call follow-up',
        note: 'Internal reminder only — no outbound message.',
        dueAt: johnDue,
        status: 'scheduled',
        jobId: DEMO_FOLLOW_UP_JOBS.johnScheduled,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: followUps.id,
        set: {
          subject: 'Confirm discovery call follow-up',
          note: 'Internal reminder only — no outbound message.',
          dueAt: johnDue,
          status: 'scheduled',
          jobId: DEMO_FOLLOW_UP_JOBS.johnScheduled,
          updatedAt: now,
        },
      });

    const sarahOutcome =
      'Follow-up completed: Re-check billing dispute status. Note: Internal check only. Internal outcome only; no external actions were taken.';
    await tx
      .insert(followUps)
      .values({
        id: DEMO_FOLLOW_UPS.sarahCompleted,
        agentId: DEMO_AGENTS.sarah,
        source: 'admin',
        createdBy: DEMO_ACTOR,
        subject: 'Re-check billing dispute status',
        note: 'Internal check only',
        dueAt: sarahDue,
        status: 'completed',
        attempts: 1,
        jobId: DEMO_FOLLOW_UP_JOBS.sarahCompleted,
        startedAt: sarahDue,
        finishedAt: sarahFinished,
        outcome: sarahOutcome,
        outcomeKind: 'executed',
        createdAt: sarahDue,
        updatedAt: sarahFinished,
      })
      .onConflictDoUpdate({
        target: followUps.id,
        set: {
          subject: 'Re-check billing dispute status',
          note: 'Internal check only',
          dueAt: sarahDue,
          status: 'completed',
          attempts: 1,
          jobId: DEMO_FOLLOW_UP_JOBS.sarahCompleted,
          finishedAt: sarahFinished,
          outcome: sarahOutcome,
          outcomeKind: 'executed',
          updatedAt: sarahFinished,
        },
      });

    await tx
      .insert(agentActivityEvents)
      .values({
        id: DEMO_ACTIVITY.sarahFollowUpCompleted,
        agentId: DEMO_AGENTS.sarah,
        kind: 'follow_up.completed',
        summary: 'Follow-up completed: Re-check billing dispute status',
        detail: sarahOutcome,
        followUpId: DEMO_FOLLOW_UPS.sarahCompleted,
        createdAt: sarahFinished,
      })
      .onConflictDoUpdate({
        target: agentActivityEvents.id,
        set: {
          kind: 'follow_up.completed',
          summary: 'Follow-up completed: Re-check billing dispute status',
          detail: sarahOutcome,
          followUpId: DEMO_FOLLOW_UPS.sarahCompleted,
          createdAt: sarahFinished,
        },
      });
    const replyOutcome = 'A reply was saved in the conversation before the deadline.';
    await tx
      .insert(followUps)
      .values({
        id: DEMO_FOLLOW_UPS.sarahReplyReceived,
        agentId: DEMO_AGENTS.sarah,
        source: 'agent',
        createdBy: DEMO_ACTOR,
        subject: 'Wait for the customer’s billing question',
        waitForEvent: 'reply',
        channel: 'email',
        conversationId: DEMO_EMAIL.threadId,
        replyEmailId: DEMO_EMAIL.messageId,
        continuationRunId: DEMO_EMAIL.runId,
        dueAt: demoTime(now, 60 * 60 * 1000),
        status: 'completed',
        outcomeKind: 'reply_received',
        outcome: replyOutcome,
        createdAt: demoTime(now, -60 * 60 * 1000),
        finishedAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await tx
      .insert(agentActivityEvents)
      .values({
        id: DEMO_ACTIVITY.sarahReplyReceived,
        agentId: DEMO_AGENTS.sarah,
        followUpId: DEMO_FOLLOW_UPS.sarahReplyReceived,
        kind: 'follow_up.reply_received',
        summary: 'Reply received: Wait for the customer’s billing question',
        detail: replyOutcome,
        createdAt: now,
      })
      .onConflictDoNothing();
  },
};
