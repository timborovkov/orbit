import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { recipientConsentFailure } from '@/lib/policy/consent';
import { evaluateCandidate, loadPolicyContext } from '@/lib/policy/gateway';
import type { JobRecord } from '@/lib/queue/types';
import {
  extractEmailAddress,
  replySubject,
  replyThreadingHeaders,
  sendingDomainMatches,
} from '@/lib/runtime/email/headers';
import { sendingEmailDomain } from '@/lib/runtime/email/settings';
import { createResendTransport, type EmailTransport } from '@/lib/runtime/email/transport';
import { RetryableInfrastructureError } from '@/lib/runtime/errors';
import {
  claimOutboundForSending,
  loadOutboundForDispatch,
  markOutboundStatus,
  recordOutboundUsage,
} from '@/lib/runtime/outbound/dispatch';
import { EMAIL_SEND_ACTION } from '@/lib/runtime/outbound/types';
import { emailMailboxes, emailMessages, outboundActions, policyDecisions } from '@/lib/schema';

function draftBody(payload: Record<string, unknown>, fallback: string): string {
  const draft = payload.draft;
  if (typeof draft === 'string' && draft.trim()) return draft.trim().slice(0, 8000);
  return fallback.trim().slice(0, 8000);
}

/**
 * Worker handler for `email.send`. Rechecks policy at dispatch time, derives
 * destination and threading from the stored inbound message, and sends through
 * the injected transport (Resend in production, stub in tests).
 */
export async function processEmailSendJob(
  job: JobRecord,
  signal: AbortSignal,
  transport?: EmailTransport,
  options: { apiKey?: string; sendingDomain?: string } = {},
): Promise<void> {
  const outboundId = typeof job.payload.outboundId === 'string' ? job.payload.outboundId : null;
  const actor = typeof job.payload.actor === 'string' ? job.payload.actor : 'system:email-send';
  if (!outboundId) throw new Error('email.send job missing outboundId');

  const loaded = await loadOutboundForDispatch(outboundId);
  if (!loaded) return;
  const { outbound, intent } = loaded;

  if (intent.reviewStatus === 'rejected' || intent.decision === 'deny') {
    await db().transaction(async (tx) => {
      await markOutboundStatus(tx, outbound.id, {
        status: 'blocked',
        reason: 'Proposal was rejected; outbound send cancelled.',
        completedAt: new Date(),
      });
    });
    return;
  }

  if (outbound.status === 'sent') return;

  const claimed = await db().transaction(async (tx) => claimOutboundForSending(tx, outbound.id));
  if (!claimed) return;
  if (claimed.alreadySent) {
    if (claimed.reconciled && claimed.row.providerMessageId) {
      await db().transaction(async (tx) => {
        await markOutboundStatus(tx, outbound.id, {
          status: 'sent',
          provider: claimed.row.provider ?? 'resend',
          providerMessageId: claimed.row.providerMessageId,
          providerResult: claimed.row.providerResult ?? { reconciled: true },
          completedAt: new Date(),
        });
      });
    }
    return;
  }
  if ('terminal' in claimed && claimed.terminal) return;

  if (!outbound.emailMessageId) {
    await db().transaction(async (tx) => {
      await markOutboundStatus(tx, outbound.id, {
        status: 'blocked',
        reason: 'Inbound message reference is missing; cannot derive reply headers.',
        completedAt: new Date(),
      });
    });
    return;
  }

  const message = (
    await db()
      .select()
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.id, outbound.emailMessageId),
          eq(emailMessages.agentId, outbound.agentId),
        ),
      )
  ).at(0);
  if (!message) {
    await db().transaction(async (tx) => {
      await markOutboundStatus(tx, outbound.id, {
        status: 'blocked',
        reason: 'Inbound message was deleted before dispatch.',
        completedAt: new Date(),
      });
    });
    return;
  }

  const mailbox = (
    await db().select().from(emailMailboxes).where(eq(emailMailboxes.agentId, outbound.agentId))
  ).at(0);
  if (!mailbox?.enabled) {
    await db().transaction(async (tx) => {
      await markOutboundStatus(tx, outbound.id, {
        status: 'blocked',
        reason: 'Agent mailbox is disabled.',
        completedAt: new Date(),
      });
    });
    return;
  }

  const domain = options.sendingDomain ?? sendingEmailDomain(process.env.RESEND_SENDING_DOMAIN);
  if (!sendingDomainMatches(mailbox.address, domain)) {
    await db().transaction(async (tx) => {
      await markOutboundStatus(tx, outbound.id, {
        status: 'blocked',
        reason: 'Mailbox address is not on the configured sending domain.',
        completedAt: new Date(),
      });
    });
    return;
  }

  const to = extractEmailAddress(message.sender);
  if (!to) {
    await db().transaction(async (tx) => {
      await markOutboundStatus(tx, outbound.id, {
        status: 'blocked',
        reason: 'Inbound sender address is not a valid reply destination.',
        completedAt: new Date(),
      });
    });
    return;
  }

  const ctx = await loadPolicyContext(outbound.agentId, actor, intent.runId);
  if (!ctx) {
    await db().transaction(async (tx) => {
      await markOutboundStatus(tx, outbound.id, {
        status: 'blocked',
        reason: 'Agent unavailable for dispatch policy checks.',
        completedAt: new Date(),
      });
    });
    return;
  }

  const policy = await db().transaction(async (tx) => {
    const consent = await recipientConsentFailure(
      tx,
      outbound.agentId,
      EMAIL_SEND_ACTION,
      [to],
      ctx.consentRequiredTools,
    );
    return evaluateCandidate(
      ctx,
      {
        type: EMAIL_SEND_ACTION,
        idempotencyKey: outbound.idempotencyKey,
        payload: { draft: outbound.body },
        recipients: [to],
      },
      consent,
      false,
      { skipApproval: true },
    );
  });

  if (policy.decision !== 'allow') {
    await db().transaction(async (tx) => {
      await tx.insert(policyDecisions).values({
        agentId: outbound.agentId,
        runId: intent.runId,
        actionType: EMAIL_SEND_ACTION,
        decision: policy.decision,
        reasons: policy.reasons,
        intentId: intent.id,
        actor,
      });
      await markOutboundStatus(tx, outbound.id, {
        status: 'blocked',
        reason: policy.reasons.join(' ') || 'Dispatch blocked by policy.',
        completedAt: new Date(),
      });
    });
    return;
  }

  const body = draftBody(intent.payload, outbound.body);
  if (!body) {
    await db().transaction(async (tx) => {
      await markOutboundStatus(tx, outbound.id, {
        status: 'blocked',
        reason: 'Approved reply body is empty.',
        completedAt: new Date(),
      });
    });
    return;
  }

  const threading = replyThreadingHeaders(message);
  const headers: Record<string, string> = {};
  if (threading.inReplyTo) headers['In-Reply-To'] = threading.inReplyTo;
  if (threading.references) headers.References = threading.references;

  const activeTransport =
    transport ??
    (() => {
      const apiKey = options.apiKey ?? process.env.RESEND_API_KEY;
      if (!apiKey?.trim()) return null;
      return createResendTransport(apiKey.trim());
    })();

  if (!activeTransport) {
    await db().transaction(async (tx) => {
      await markOutboundStatus(tx, outbound.id, {
        status: 'blocked',
        reason: 'Resend API key is not configured on the worker.',
        completedAt: new Date(),
      });
    });
    return;
  }

  const outcome = await activeTransport.send(
    {
      from: mailbox.address,
      to,
      subject: replySubject(message.subject),
      text: body,
      headers,
      idempotencyKey: outbound.idempotencyKey,
    },
    signal,
  );

  if (outcome.ok) {
    await db().transaction(async (tx) => {
      const current = (
        await tx
          .select()
          .from(outboundActions)
          .where(eq(outboundActions.id, outbound.id))
          .for('update')
      ).at(0);
      if (current?.status === 'sent') return;
      await markOutboundStatus(tx, outbound.id, {
        status: 'sent',
        reason: null,
        provider: 'resend',
        providerMessageId: outcome.id,
        providerResult: outcome.raw,
        completedAt: new Date(),
      });
      await recordOutboundUsage(tx, outbound.agentId);
      await tx.insert(policyDecisions).values({
        agentId: outbound.agentId,
        runId: intent.runId,
        actionType: EMAIL_SEND_ACTION,
        decision: 'allow',
        reasons: ['Outbound email sent.'],
        intentId: intent.id,
        actor,
      });
    });
    return;
  }

  if (outcome.retryable) {
    throw new RetryableInfrastructureError(outcome.error);
  }

  await db().transaction(async (tx) => {
    await markOutboundStatus(tx, outbound.id, {
      status: 'failed',
      reason: outcome.error,
      provider: 'resend',
      providerResult: outcome.raw ?? null,
      completedAt: new Date(),
    });
  });
}
