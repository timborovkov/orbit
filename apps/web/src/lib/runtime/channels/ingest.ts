import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { db, type Tx } from '@/lib/db';
import { canAcceptBackgroundWork } from '@/lib/lifecycle';
import { recipientId } from '@/lib/policy/scopes';
import { enqueueJob } from '@/lib/queue/jobs';
import type { JobRecord } from '@/lib/queue/types';
import { channelAdapter } from '@/lib/runtime/channels/registry';
import { admitRun } from '@/lib/runtime/execute';
import { linkReplyCommitments, resolveConversationReply } from '@/lib/runtime/follow-ups/replies';
import { agents, configurations, jobs, sourceEvents } from '@/lib/schema';

export const CHANNEL_EVENT_JOB = 'channel.event';

const eventInput = z.object({
  agentId: z.uuid(),
  channel: z.string(),
  externalId: z.string().min(1).max(500),
  accountId: z.string().min(1).max(500).optional(),
  threadId: z.string().min(1).max(500).optional(),
  isReply: z.boolean().default(false),
  text: z.string().trim().min(1).max(16000),
  authorId: z.string().min(1).max(500).optional(),
  authorUsername: z.string().max(500).optional(),
  authorName: z.string().max(500).optional(),
  occurredAt: z.date().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  recipients: z.array(recipientId).max(2).default([]),
});

/** Persist normalized evidence under the agent lock before advancing a provider cursor. */
export async function persistChannelEvent(
  tx: Tx,
  event: typeof sourceEvents.$inferInsert,
  options: { isReply?: boolean } = {},
) {
  const [existing] = await tx
    .select({ id: sourceEvents.id })
    .from(sourceEvents)
    .where(
      and(
        eq(sourceEvents.agentId, event.agentId),
        eq(sourceEvents.provider, event.provider),
        eq(sourceEvents.providerEventId, event.providerEventId),
        event.accountId
          ? eq(sourceEvents.accountId, event.accountId)
          : isNull(sourceEvents.accountId),
      ),
    );
  if (existing) return;
  const [source] = await tx.insert(sourceEvents).values(event).onConflictDoNothing().returning();
  if (source?.threadId && options.isReply) {
    await resolveConversationReply(
      tx,
      {
        agentId: source.agentId,
        channel: source.provider,
        accountId: source.accountId,
        conversationId: source.threadId,
      },
      { kind: 'event', id: source.id },
    );
  }
  return source;
}

/**
 * Authenticated adapters resolve the agent and channel server-side. Use the provider
 * account when event or thread IDs are account-local, and a stable conversation ID
 * for threadId. Author IDs must identify the same person across that channel.
 */
export async function ingestChannelEvent(input: z.input<typeof eventInput>) {
  const event = eventInput.parse(input);
  if (!channelAdapter(event.channel)) throw new Error('Channel is not registered.');
  return db().transaction(async (tx) => {
    const [agent] = await tx
      .select()
      .from(agents)
      .where(eq(agents.id, event.agentId))
      .for('update');
    if (!agent || !canAcceptBackgroundWork(agent.lifecycle)) return null;
    const [config] = await tx
      .select({ id: configurations.id })
      .from(configurations)
      .where(eq(configurations.agentId, event.agentId))
      .orderBy(desc(configurations.version))
      .limit(1);
    if (!config) return null;
    const source = await persistChannelEvent(
      tx,
      {
        agentId: event.agentId,
        provider: event.channel,
        providerEventId: event.externalId,
        accountId: event.accountId,
        threadId: event.threadId,
        admissionStatus: 'pending',
        text: event.text,
        authorId: event.authorId,
        authorUsername: event.authorUsername,
        authorName: event.authorName,
        providerCreatedAt: event.occurredAt,
        payload: event.payload,
      },
      { isReply: event.isReply },
    );
    if (!source) return null;
    const job = await enqueueJob(tx, {
      type: CHANNEL_EVENT_JOB,
      payload: {
        agentId: event.agentId,
        sourceId: source.id,
        configurationId: config.id,
        recipients: event.recipients,
      },
      idempotencyKey: `channel.event:${source.id}`,
    });
    return { sourceId: source.id, jobId: job.id };
  });
}

const eventJob = z.object({
  agentId: z.uuid(),
  sourceId: z.uuid(),
  configurationId: z.uuid(),
  recipients: z.array(recipientId).max(2),
});

export async function processChannelEventJob(job: JobRecord) {
  const payload = eventJob.parse(job.payload);
  return db().transaction(async (tx) => {
    const [agent] = await tx
      .select()
      .from(agents)
      .where(eq(agents.id, payload.agentId))
      .for('update');
    if (!agent) return;
    const [claim] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.id, job.id),
          eq(jobs.type, CHANNEL_EVENT_JOB),
          eq(jobs.status, 'claimed'),
          eq(jobs.claimedBy, job.claimedBy ?? ''),
          eq(jobs.attempts, job.attempts),
        ),
      )
      .for('update');
    if (!claim) return;
    const [source] = await tx
      .select()
      .from(sourceEvents)
      .where(and(eq(sourceEvents.id, payload.sourceId), eq(sourceEvents.agentId, payload.agentId)))
      .for('update');
    if (!source || source.runId || source.admissionStatus === 'rejected') return;
    const admitted = canAcceptBackgroundWork(agent.lifecycle)
      ? await admitChannelEvent(tx, agent, source, {
          configurationId: payload.configurationId,
          input: source.text,
          recipients: payload.recipients,
          actor: `system:${source.provider}`,
        })
      : { error: `Agent is ${agent.lifecycle}.` };
    if (!('error' in admitted) || !admitted.error) return;
    const violation = 'budgetViolation' in admitted ? admitted.budgetViolation : undefined;
    await tx
      .update(sourceEvents)
      .set({
        admissionStatus: violation ? 'deferred' : 'rejected',
        admissionReason: admitted.error,
      })
      .where(eq(sourceEvents.id, source.id));
    if (violation) {
      return { deferUntil: new Date(Date.now() + (violation === 'concurrency' ? 5_000 : 60_000)) };
    }
  });
}

/** Link durable evidence to its run and queue job in the same transaction. */
export async function admitChannelEvent(
  tx: Tx,
  agent: typeof agents.$inferSelect,
  source: typeof sourceEvents.$inferSelect,
  input: { configurationId: string; input: string; actor: string; recipients?: string[] },
) {
  const adapter = channelAdapter(source.provider);
  if (!adapter || source.agentId !== agent.id || source.runId)
    return { error: 'Channel source is unavailable.' };
  const admitted = await admitRun(tx, agent, {
    ...input,
    origin: adapter.legacyOrigin ?? 'channel',
    channel: adapter.id,
  });
  if ('runId' in admitted && admitted.runId) {
    await linkReplyCommitments(tx, agent.id, { kind: 'event', id: source.id }, admitted.runId);
    await tx
      .update(sourceEvents)
      .set({
        runId: admitted.runId,
        ...(source.admissionStatus ? { admissionStatus: 'admitted', admissionReason: null } : {}),
      })
      .where(eq(sourceEvents.id, source.id));
  }
  return admitted;
}
