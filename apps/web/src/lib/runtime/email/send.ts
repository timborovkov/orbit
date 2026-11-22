import { and, eq } from 'drizzle-orm';

import type { Tx } from '@/lib/db';
import type { JobRecord } from '@/lib/queue/types';
import type { ActionIntent, OutboundRow } from '@/lib/runtime/channels/types';
import {
  extractEmailAddress,
  replySubject,
  replyThreadingHeaders,
  sendingDomainMatches,
} from '@/lib/runtime/email/headers';
import { sendingEmailDomain } from '@/lib/runtime/email/settings';
import { createResendTransport, type EmailTransport } from '@/lib/runtime/email/transport';
import { processOutboundJob } from '@/lib/runtime/outbound/process';
import { EMAIL_SEND_ACTION } from '@/lib/runtime/outbound/types';
import { emailMailboxes, emailMessages } from '@/lib/schema';

export {
  finalizeExhaustedOutboundJob,
  reconcileCancelledOutboundJobs,
  reconcileDeadOutboundJobs,
} from '@/lib/runtime/outbound/process';

export async function validateEmailApproval(tx: Tx, intent: ActionIntent) {
  const [mailbox] = await tx
    .select({ enabled: emailMailboxes.enabled })
    .from(emailMailboxes)
    .where(eq(emailMailboxes.agentId, intent.agentId));
  if (!mailbox?.enabled) return 'Enable the agent mailbox before approving an email reply.';
  if (typeof intent.payload.draft !== 'string' || !intent.payload.draft.trim()) {
    return 'Approved email replies need a non-empty draft.';
  }
}

export async function prepareEmailDelivery(
  tx: Tx,
  outbound: OutboundRow,
  intent: ActionIntent,
  transport?: EmailTransport,
  options: { apiKey?: string; sendingDomain?: string } = {},
) {
  if (!outbound.emailMessageId) {
    return { error: 'Inbound message reference is missing; cannot derive reply headers.' };
  }
  const [message] = await tx
    .select()
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.id, outbound.emailMessageId),
        eq(emailMessages.agentId, outbound.agentId),
      ),
    );
  if (!message) return { error: 'Inbound message was deleted before dispatch.' };
  const to = extractEmailAddress(message.sender);
  if (!to) return { error: 'Inbound sender address is not a valid reply destination.' };
  const body = (
    typeof intent.payload.draft === 'string' && intent.payload.draft.trim()
      ? intent.payload.draft
      : outbound.body
  )
    .trim()
    .slice(0, 8000);
  if (!body) return { error: 'Approved reply body is empty.' };

  const apiKey = options.apiKey ?? process.env.RESEND_API_KEY;
  const activeTransport =
    transport ?? (apiKey?.trim() ? createResendTransport(apiKey.trim()) : null);
  if (!activeTransport) return { error: 'Resend API key is not configured on the worker.' };

  const [mailbox] = await tx
    .select()
    .from(emailMailboxes)
    .where(eq(emailMailboxes.agentId, outbound.agentId))
    .for('update');
  if (!mailbox?.enabled) return { error: 'Agent mailbox is disabled.' };
  const domain = options.sendingDomain ?? sendingEmailDomain(process.env.RESEND_SENDING_DOMAIN);
  if (!sendingDomainMatches(mailbox.address, domain)) {
    return { error: 'Mailbox address is not on the configured sending domain.' };
  }

  const threading = replyThreadingHeaders(message);
  const headers: Record<string, string> = {};
  if (threading.inReplyTo) headers['In-Reply-To'] = threading.inReplyTo;
  if (threading.references) headers.References = threading.references;
  return {
    recipients: [to],
    send: (signal: AbortSignal) =>
      activeTransport.send(
        {
          from: mailbox.address,
          to,
          subject: replySubject(message.subject),
          text: body,
          headers,
          idempotencyKey: outbound.idempotencyKey,
        },
        signal,
      ),
  };
}

/** Compatibility entry point for integrations injecting a Resend transport. */
export function processEmailSendJob(
  job: JobRecord,
  signal: AbortSignal,
  transport?: EmailTransport,
  options: { apiKey?: string; sendingDomain?: string } = {},
) {
  return processOutboundJob(job, signal, {
    actionType: EMAIL_SEND_ACTION,
    prepareDelivery: (tx, outbound, intent) =>
      prepareEmailDelivery(tx, outbound, intent, transport, options),
  });
}
