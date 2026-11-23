import { createHash } from 'node:crypto';

import { type Tool, tool } from 'ai';
import { and, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';

import { type Db, db, type Tx } from '@/lib/db';
import { authorizeAction, type PolicyContext } from '@/lib/policy/gateway';
import { enqueueJob } from '@/lib/queue/jobs';
import { lockApprovalAgent } from '@/lib/runtime/approval-work';
import { channelAdapter } from '@/lib/runtime/channels/registry';
import { parseOffsetBearingDueAt } from '@/lib/runtime/follow-ups/due';
import { commitmentClock } from '@/lib/runtime/follow-ups/state';
import {
  type CommitmentAnchor,
  commitmentGrants,
  type CommitmentTool,
  FOLLOW_UP_ACTIVITY_KINDS,
  FOLLOW_UP_JOB_TYPE,
} from '@/lib/runtime/follow-ups/types';
import type { ToolCallRecord } from '@/lib/runtime/skills';
import type { ToolStepGate } from '@/lib/runtime/tool-steps';
import { agentActivityEvents, emailMessages, followUps, sourceEvents } from '@/lib/schema';

const inputSchema = z.object({
  subject: z.string().min(1).max(200).describe('What to follow up on in this conversation.'),
  note: z.string().max(2000).optional().describe('Context for the follow-up draft.'),
  dueAt: z.string().max(40).describe('Future ISO-8601 deadline with an explicit timezone.'),
});

async function findAnchor(store: Db | Tx, policy: PolicyContext): Promise<CommitmentAnchor | null> {
  const { agentId, runId, runChannel: channel } = policy;
  if (!runId || !channel || !channelAdapter(channel)?.followUp) return null;
  if (channel === 'email') {
    const [message] = await store
      .select({ anchorId: emailMessages.id, conversationId: emailMessages.threadId })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.agentId, agentId),
          eq(emailMessages.runId, runId),
          isNotNull(emailMessages.body),
        ),
      );
    return message ? { agentId, channel, accountId: null, ...message } : null;
  }
  const [event] = await store
    .select({
      anchorId: sourceEvents.id,
      accountId: sourceEvents.accountId,
      conversationId: sourceEvents.threadId,
    })
    .from(sourceEvents)
    .where(
      and(
        eq(sourceEvents.agentId, agentId),
        eq(sourceEvents.runId, runId),
        eq(sourceEvents.provider, channel),
      ),
    );
  return event?.conversationId
    ? { ...event, agentId, channel, conversationId: event.conversationId }
    : null;
}

async function scheduleConversationCommitment(
  policy: PolicyContext,
  executionToken: string,
  type: CommitmentTool,
  args: z.infer<typeof inputSchema>,
) {
  const subject = args.subject.trim();
  const note = args.note?.trim() ?? '';
  const dueAt = parseOffsetBearingDueAt(args.dueAt);
  if (!subject || !dueAt) return { error: 'Enter a subject and an ISO deadline with a timezone.' };
  const { agentId, runId } = policy;
  return db().transaction(async (tx) => {
    if (!runId || !(await lockApprovalAgent(tx, agentId))) {
      return { error: 'The originating run is unavailable.' };
    }
    const anchor = await findAnchor(tx, policy);
    if (!anchor) return { error: 'This run has no supported, saved conversation.' };
    const key = createHash('sha256')
      .update(JSON.stringify([runId, type, anchor.anchorId, dueAt.toISOString(), subject, note]))
      .digest('hex');
    const decision = await authorizeAction(
      policy,
      {
        type,
        executionToken,
        idempotencyKey: `commitment:${key}`,
        payload: { dueAt: dueAt.toISOString() },
      },
      tx,
    );
    if (decision.decision !== 'allow') return { error: decision.reasons.join(' ') };

    const id = decision.intentId;
    const [existing] = await tx
      .select({ status: followUps.status })
      .from(followUps)
      .where(and(eq(followUps.id, id), eq(followUps.agentId, agentId)));
    if (existing) return { commitmentId: id, status: existing.status, dueAt: dueAt.toISOString() };

    const now = await commitmentClock(tx);
    if (dueAt <= now) return { error: 'The deadline must be in the future.' };
    const job = await enqueueJob(tx, {
      type: FOLLOW_UP_JOB_TYPE,
      payload: { agentId, followUpId: id },
      availableAt: dueAt,
      idempotencyKey: `followup:${id}`,
    });
    const waitForReply = type === 'commitments.wait_for_reply';
    await tx.insert(followUps).values({
      id,
      ...anchor,
      source: 'agent',
      createdBy: policy.actor,
      originatingRunId: runId,
      subject,
      note,
      dueAt,
      waitForEvent: waitForReply ? 'reply' : null,
      jobId: job.id,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(agentActivityEvents).values({
      agentId,
      followUpId: id,
      kind: FOLLOW_UP_ACTIVITY_KINDS.scheduled,
      summary: waitForReply ? `Waiting for reply: ${subject}` : `Follow-up scheduled: ${subject}`,
      createdAt: now,
    });
    return { commitmentId: id, status: 'scheduled' as const, dueAt: dueAt.toISOString() };
  });
}

export async function commitmentTools(options: {
  policy: PolicyContext;
  executionToken: string;
  gate: ToolStepGate;
  calls: ToolCallRecord[];
  signal: AbortSignal;
}): Promise<Record<string, Tool>> {
  const { policy, executionToken, gate, calls, signal } = options;
  const enabled = new Set(policy.enabledTools);
  const grants = commitmentGrants.filter(({ type }) => enabled.has(type));
  if (
    !grants.length ||
    !gate.max ||
    policy.runOrigin === 'playground' ||
    policy.executionContext === 'replay' ||
    !(await findAnchor(db(), policy))
  )
    return {};

  return Object.fromEntries(
    grants.map(({ type }) => {
      const wait = type === 'commitments.wait_for_reply';
      const name = wait ? 'wait_for_reply' : 'schedule_follow_up';
      return [
        name,
        tool({
          description: wait
            ? 'Wait for the next reply in this conversation. If the deadline wins, Orbit prepares a follow-up for administrator review.'
            : 'Schedule a draft follow-up for administrator review in this conversation at a future time.',
          inputSchema,
          async execute(args) {
            if (!gate.tryConsume()) return { error: 'Maximum tool steps for this run reached.' };
            signal.throwIfAborted();
            let result: Awaited<ReturnType<typeof scheduleConversationCommitment>>;
            try {
              result = await scheduleConversationCommitment(policy, executionToken, type, args);
            } catch {
              signal.throwIfAborted();
              result = { error: 'The commitment could not be scheduled.' };
            }
            calls.push({
              tool: type,
              args: { dueAt: args.dueAt },
              policy: result.error ? 'deny' : 'allow',
              result,
            });
            return result;
          },
        }),
      ];
    }),
  );
}
