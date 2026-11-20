import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { db, type Tx } from '@/lib/db';
import { canAcceptBackgroundWork } from '@/lib/lifecycle';
import { enqueueJob } from '@/lib/queue/jobs';
import {
  EMAIL_RECEIVE_JOB,
  inboundEmailDomain,
  inboundWebhookSecret,
} from '@/lib/runtime/email/settings';
import {
  agents,
  audit,
  configurations,
  emailMailboxes,
  emailMessages,
  emailThreads,
} from '@/lib/schema';

export function inboundEmailConfigured() {
  return Boolean(
    inboundEmailDomain(process.env.RESEND_INBOUND_DOMAIN) &&
    inboundWebhookSecret(process.env.RESEND_WEBHOOK_SECRET),
  );
}

export async function setEmailEnabled(actor: string, agentId: string, enabled: boolean) {
  const domain = inboundEmailDomain(process.env.RESEND_INBOUND_DOMAIN);
  if (enabled && (!domain || !inboundEmailConfigured())) {
    return { error: 'Configure Resend receiving before enabling email.' };
  }
  return await db().transaction(async (tx) => {
    const agent = (
      await tx
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, agentId))
        .for('update')
    ).at(0);
    if (!agent) return { error: 'Agent unavailable.' };
    if (enabled && domain) {
      await tx
        .insert(emailMailboxes)
        .values({ agentId, address: `agent-${randomUUID()}@${domain}`, enabled })
        .onConflictDoUpdate({ target: emailMailboxes.agentId, set: { enabled } });
    } else {
      await tx.update(emailMailboxes).set({ enabled }).where(eq(emailMailboxes.agentId, agentId));
      await tx
        .update(emailMessages)
        .set({ skipReason: 'Agent email is disabled.', waitingForCapacity: false })
        .where(
          and(
            eq(emailMessages.agentId, agentId),
            isNull(emailMessages.runId),
            isNull(emailMessages.skipReason),
          ),
        );
    }
    await tx.insert(audit).values({
      actor,
      action: `${enabled ? 'Enabled' : 'Disabled'} inbound email for ${agent.name}`,
    });
    return { message: enabled ? 'Inbound email enabled.' : 'Inbound email disabled.' };
  });
}

export const receivedEvent = z.looseObject({
  type: z.literal('email.received'),
  data: z.looseObject({
    email_id: z.uuid(),
    created_at: z.iso.datetime({ offset: true }),
    from: z.string().max(1000),
    subject: z.string().max(2000).nullish(),
    to: z.array(z.string().max(512)).max(1000),
    cc: z.array(z.string().max(512)).max(1000).optional(),
    bcc: z.array(z.string().max(512)).max(1000).optional(),
  }),
});

export async function persistReceivedEmail(event: z.infer<typeof receivedEvent>) {
  const data = event.data;
  const recipients = [
    ...new Set(
      [...data.to, ...(data.cc ?? []), ...(data.bcc ?? [])]
        .map((address) => address.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!recipients.length) return;

  await db().transaction(async (tx) => {
    // Acquire all agent locks in one order so overlapping multi-recipient webhooks
    // serialize with one another and with mailbox and lifecycle changes.
    const candidates = await tx
      .select({ id: agents.id, lifecycle: agents.lifecycle })
      .from(agents)
      .innerJoin(emailMailboxes, eq(agents.id, emailMailboxes.agentId))
      .where(inArray(emailMailboxes.address, recipients))
      .orderBy(asc(agents.id))
      .for('update', { of: agents });

    const results = await Promise.allSettled(
      candidates.map((agent) => persistAgentEmail(tx, agent, event)),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  });
}

async function persistAgentEmail(
  tx: Tx,
  agent: Pick<typeof agents.$inferSelect, 'id' | 'lifecycle'>,
  event: z.infer<typeof receivedEvent>,
) {
  const agentId = agent.id;
  const data = event.data;
  const mailbox = (
    await tx
      .select({ enabled: emailMailboxes.enabled })
      .from(emailMailboxes)
      .where(eq(emailMailboxes.agentId, agentId))
  ).at(0);
  if (!mailbox?.enabled) return;
  const duplicate = (
    await tx
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(
        and(eq(emailMessages.agentId, agentId), eq(emailMessages.resendEmailId, data.email_id)),
      )
  ).at(0);
  if (duplicate) return;

  const config = (
    await tx
      .select({ id: configurations.id })
      .from(configurations)
      .where(eq(configurations.agentId, agentId))
      .orderBy(desc(configurations.version))
      .limit(1)
  ).at(0);
  const threadId = randomUUID();
  await tx.insert(emailThreads).values({ id: threadId, agentId });
  const message = (
    await tx
      .insert(emailMessages)
      .values({
        agentId,
        threadId,
        resendEmailId: data.email_id,
        event,
        sender: data.from,
        subject: data.subject ?? '',
        receivedAt: new Date(data.created_at),
        configurationId: config?.id,
        skipReason: !canAcceptBackgroundWork(agent.lifecycle)
          ? `Agent is ${agent.lifecycle}.`
          : null,
      })
      .returning({ id: emailMessages.id })
  ).at(0);
  if (!message) throw new Error('Inbound email insert failed');
  const job = await enqueueJob(tx, {
    type: EMAIL_RECEIVE_JOB,
    payload: { messageId: message.id, agentId },
    idempotencyKey: `email.receive:${agentId}:${data.email_id}`,
  });
  await tx
    .update(emailMessages)
    .set({ receiveJobId: job.id })
    .where(eq(emailMessages.id, message.id));
}
