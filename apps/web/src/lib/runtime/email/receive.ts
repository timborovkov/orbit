import { and, asc, desc, eq, inArray, isNotNull, lt, ne, or, sql } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import { canAcceptBackgroundWork } from '@/lib/lifecycle';
import { activeJobClaim } from '@/lib/queue/jobs';
import type { JobRecord } from '@/lib/queue/types';
import type { fetchReceivedEmail } from '@/lib/runtime/email/provider';
import { EMAIL_ACTOR, EMAIL_RECEIVE_JOB } from '@/lib/runtime/email/settings';
import { admitRun } from '@/lib/runtime/execute';
import {
  hasReplyCommitment,
  linkReplyCommitments,
  mergeCommitmentConversations,
  resolveConversationReply,
} from '@/lib/runtime/follow-ups/replies';
import { emailXClaim, reconcilePeople } from '@/lib/runtime/people/identity';
import {
  agents,
  emailMailboxes,
  emailMessages,
  emailThreads,
  jobs,
  outboundActions,
} from '@/lib/schema';

type Message = typeof emailMessages.$inferSelect;
type Received = Awaited<ReturnType<typeof fetchReceivedEmail>>;

async function storeMessage(tx: Tx, message: Message, received: Received) {
  const { agentId } = message;
  const parentIds = [...received.inReplyTo, ...received.referenceIds.toReversed()].filter(
    (id) => id !== received.messageId,
  );
  const parents = parentIds.length
    ? await tx
        .select({
          id: emailMessages.messageId,
          threadId: emailMessages.threadId,
        })
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.agentId, agentId),
            inArray(emailMessages.messageId, parentIds),
            isNotNull(emailMessages.body),
          ),
        )
        .orderBy(asc(emailMessages.receivedAt), asc(emailMessages.id))
    : [];
  const parentThread = parentIds
    .map((id) => parents.find((parent) => parent.id === id)?.threadId)
    .find(Boolean);
  const lateChildren = received.messageId
    ? await tx
        .selectDistinct({ id: emailThreads.id })
        .from(emailThreads)
        .innerJoin(
          emailMessages,
          and(eq(emailMessages.threadId, emailThreads.id), eq(emailMessages.agentId, agentId)),
        )
        .where(
          and(
            eq(emailThreads.agentId, agentId),
            eq(emailThreads.provisional, true),
            sql`(${received.messageId} = ANY(${emailMessages.inReplyTo}) OR ${received.messageId} = ANY(${emailMessages.referenceIds}))`,
          ),
        )
        .orderBy(asc(emailThreads.id))
    : [];

  const threadId = parentThread ?? lateChildren.at(0)?.id ?? message.threadId;
  const conversation = { agentId, channel: 'email', accountId: null, conversationId: threadId };
  if (!parentThread) {
    await tx
      .update(emailThreads)
      .set({ provisional: parentIds.length > 0 })
      .where(and(eq(emailThreads.agentId, agentId), eq(emailThreads.id, threadId)));
  }
  const personClaim = message.personIdentityId ? emailXClaim(received.body) : null;
  await tx
    .update(emailMessages)
    .set({ ...received, threadId, personClaim })
    .where(eq(emailMessages.id, message.id));
  if (personClaim) await reconcilePeople(tx);
  const mergedIds = [
    ...new Set([message.threadId, ...lateChildren.map((thread) => thread.id)]),
  ].filter((id) => id !== threadId);
  if (mergedIds.length) {
    await mergeCommitmentConversations(tx, conversation, mergedIds);
    await tx
      .update(emailMessages)
      .set({ threadId })
      .where(and(eq(emailMessages.agentId, agentId), inArray(emailMessages.threadId, mergedIds)));
    // Retarget outbound rows before deleting provisional threads so agent ownership stays intact.
    await tx
      .update(outboundActions)
      .set({ threadId, updatedAt: new Date() })
      .where(
        and(eq(outboundActions.agentId, agentId), inArray(outboundActions.threadId, mergedIds)),
      );
    await tx
      .delete(emailThreads)
      .where(and(eq(emailThreads.agentId, agentId), inArray(emailThreads.id, mergedIds)));
  }
  if (parentThread) {
    const duplicate =
      received.messageId &&
      (
        await tx
          .select({ id: emailMessages.id })
          .from(emailMessages)
          .where(
            and(
              eq(emailMessages.agentId, agentId),
              eq(emailMessages.messageId, received.messageId),
              eq(emailMessages.sender, message.sender),
              ne(emailMessages.id, message.id),
              isNotNull(emailMessages.body),
            ),
          )
          .limit(1)
      ).length > 0;
    if (!duplicate) {
      await resolveConversationReply(tx, conversation, {
        kind: 'email',
        id: message.id,
        messageId: received.messageId,
      });
    }
  }
}

/** Structured drafting snapshot used by production email runs and evaluation replay. */
export async function buildEmailDraftInput(
  tx: Tx,
  message: Message,
  followUp?: { subject: string; note: string },
) {
  const history = await tx
    .select({
      sender: emailMessages.sender,
      subject: emailMessages.subject,
      body: emailMessages.body,
    })
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.agentId, message.agentId),
        eq(emailMessages.threadId, message.threadId),
        ne(emailMessages.id, message.id),
        isNotNull(emailMessages.body),
        or(
          lt(emailMessages.receivedAt, message.receivedAt),
          and(eq(emailMessages.receivedAt, message.receivedAt), lt(emailMessages.id, message.id)),
        ),
      ),
    )
    .orderBy(desc(emailMessages.receivedAt), desc(emailMessages.id))
    .limit(5);
  return JSON.stringify({
    currentMessage: {
      subject: message.subject,
      body: message.body?.slice(0, 8_000),
      sender: message.sender,
    },
    previousMessages: history
      .reverse()
      .map((prior) => ({ ...prior, body: prior.body?.slice(0, 2_000) })),
    followUp: followUp && { subject: followUp.subject, note: followUp.note },
  });
}

async function withClaimedMessage<T>(
  job: JobRecord,
  workerId: string,
  agentId: string,
  messageId: string,
  work: (tx: Tx, agent: typeof agents.$inferSelect, message: Message) => Promise<T>,
) {
  return await db().transaction(async (tx) => {
    // Same agent-first lock as lifecycle changes, mailbox settings, and run admission.
    const agent = (await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')).at(
      0,
    );
    if (!agent) return;
    const claim = (
      await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(activeJobClaim(job.id, workerId, job), eq(jobs.type, EMAIL_RECEIVE_JOB)))
        .for('update')
    ).at(0);
    if (!claim) return;
    const message = (
      await tx
        .select()
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.id, messageId),
            eq(emailMessages.agentId, agentId),
            eq(emailMessages.receiveJobId, job.id),
          ),
        )
    ).at(0);
    if (!message || message.runId) return;
    return await work(tx, agent, message);
  });
}

export async function processEmailReceiveJob(
  job: JobRecord,
  workerId: string,
  signal: AbortSignal,
  fetchMessage: (emailId: string, signal: AbortSignal) => Promise<Received>,
) {
  const { agentId, messageId } = job.payload;
  if (typeof agentId !== 'string' || typeof messageId !== 'string')
    throw new Error('Invalid email job payload');
  const peek = (
    await db()
      .select({
        fetched: isNotNull(emailMessages.body).mapWith(Boolean),
        resendEmailId: emailMessages.resendEmailId,
        skipReason: emailMessages.skipReason,
        runId: emailMessages.runId,
      })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.agentId, agentId),
          eq(emailMessages.id, messageId),
          eq(emailMessages.receiveJobId, job.id),
        ),
      )
  ).at(0);
  if (!peek || peek.runId || (peek.fetched && peek.skipReason)) return;
  if (!peek.fetched) {
    const received = await fetchMessage(peek.resendEmailId, signal);
    signal.throwIfAborted();
    await withClaimedMessage(job, workerId, agentId, messageId, async (tx, _agent, message) => {
      if (message.body === null) await storeMessage(tx, message, received);
    });
  }
  signal.throwIfAborted();

  return await withClaimedMessage(job, workerId, agentId, messageId, async (tx, agent, message) => {
    if (message.body === null) return;
    const mailbox = (
      await tx
        .select({ enabled: emailMailboxes.enabled })
        .from(emailMailboxes)
        .where(eq(emailMailboxes.agentId, agentId))
    ).at(0);
    let skipReason = message.skipReason;
    if (!skipReason && !mailbox?.enabled) skipReason = 'Agent email is disabled.';
    if (!skipReason && !canAcceptBackgroundWork(agent.lifecycle))
      skipReason = `Agent is ${agent.lifecycle}.`;
    if (!skipReason && !message.configurationId)
      skipReason = 'The saved configuration is unavailable.';
    if (skipReason || !message.configurationId) {
      await tx
        .update(emailMessages)
        .set({ skipReason, waitingForCapacity: false })
        .where(eq(emailMessages.id, messageId));
      return;
    }

    const admitted = await admitRun(tx, agent, {
      actor: EMAIL_ACTOR,
      configurationId: message.configurationId,
      input: await buildEmailDraftInput(tx, message),
      origin: 'email',
    });
    const waitForBudget =
      !admitted.waitForCapacity &&
      admitted.budgetViolation &&
      (await hasReplyCommitment(tx, agent.id, { kind: 'email', id: message.id }));
    if (admitted.waitForCapacity || waitForBudget) {
      await tx
        .update(emailMessages)
        .set({ waitingForCapacity: true })
        .where(eq(emailMessages.id, messageId));
      return { deferUntil: new Date(Date.now() + (waitForBudget ? 60_000 : 5_000)) };
    }
    if (admitted.runId) {
      await linkReplyCommitments(tx, agent.id, { kind: 'email', id: message.id }, admitted.runId);
    }
    await tx
      .update(emailMessages)
      .set({
        runId: admitted.runId ?? null,
        skipReason: admitted.error ?? null,
        waitingForCapacity: false,
      })
      .where(eq(emailMessages.id, messageId));
  });
}
