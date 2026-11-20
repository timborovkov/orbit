import { and, eq, inArray, sql } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import { recipientConsentFailure } from '@/lib/policy/consent';
import { evaluateCandidate, loadPolicyContext } from '@/lib/policy/gateway';
import type { JobRecord } from '@/lib/queue/types';
import { lockApprovalAgent } from '@/lib/runtime/approval-work';
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
import { EMAIL_SEND_ACTION, EMAIL_SEND_JOB } from '@/lib/runtime/outbound/types';
import {
  emailMailboxes,
  emailMessages,
  jobs,
  outboundActions,
  policyDecisions,
} from '@/lib/schema';

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

  // Mailbox enablement and From address are revalidated under the lifecycle agent
  // lock immediately before transport.send so a disable race cannot slip through.
  const domain = options.sendingDomain ?? sendingEmailDomain(process.env.RESEND_SENDING_DOMAIN);

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

  // Hold the same agent lock lifecycle uses so Stop/Pause cannot cancel the job
  // after a stale allow decision and before the provider request starts.
  const dispatch = await db().transaction(async (tx) => {
    await lockApprovalAgent(tx, outbound.agentId);

    const row = (
      await tx
        .select()
        .from(outboundActions)
        .where(eq(outboundActions.id, outbound.id))
        .for('update')
    ).at(0);
    if (!row) return null;
    if (row.status === 'sent') return null;
    if (row.status === 'blocked' || row.status === 'failed') return null;
    // Lifecycle may have moved the row; do not invent a terminal state here.
    if (row.status !== 'sending') return null;

    const jobRow = (await tx.select().from(jobs).where(eq(jobs.id, job.id)).for('update')).at(0);
    if (jobRow?.status === 'cancelled') {
      await markOutboundStatus(tx, outbound.id, {
        status: 'blocked',
        reason: 'Outbound send cancelled before dispatch.',
        completedAt: new Date(),
      });
      return null;
    }
    // Lost or stolen lease: leave outbound retryable for the next claim.
    if (jobRow?.status !== 'claimed' || !job.claimedBy || jobRow.claimedBy !== job.claimedBy) {
      return null;
    }

    const liveMailbox = (
      await tx
        .select()
        .from(emailMailboxes)
        .where(eq(emailMailboxes.agentId, outbound.agentId))
        .for('update')
    ).at(0);
    if (!liveMailbox?.enabled) {
      await markOutboundStatus(tx, outbound.id, {
        status: 'blocked',
        reason: 'Agent mailbox is disabled.',
        completedAt: new Date(),
      });
      return null;
    }
    if (!sendingDomainMatches(liveMailbox.address, domain)) {
      await markOutboundStatus(tx, outbound.id, {
        status: 'blocked',
        reason: 'Mailbox address is not on the configured sending domain.',
        completedAt: new Date(),
      });
      return null;
    }

    const ctx = await loadPolicyContext(outbound.agentId, actor, intent.runId, tx);
    if (!ctx) {
      await markOutboundStatus(tx, outbound.id, {
        status: 'blocked',
        reason: 'Agent unavailable for dispatch policy checks.',
        completedAt: new Date(),
      });
      return null;
    }

    const consent = await recipientConsentFailure(
      tx,
      outbound.agentId,
      EMAIL_SEND_ACTION,
      [to],
      ctx.consentRequiredTools,
    );
    const policy = evaluateCandidate(
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

    if (policy.decision !== 'allow') {
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
      return null;
    }

    signal.throwIfAborted();
    const outcome = await activeTransport.send(
      {
        from: liveMailbox.address,
        to,
        subject: replySubject(message.subject),
        text: body,
        headers,
        idempotencyKey: outbound.idempotencyKey,
      },
      signal,
    );

    if (outcome.ok) {
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
      return null;
    }

    if (outcome.retryable) {
      return { retryable: outcome.error };
    }

    await markOutboundStatus(tx, outbound.id, {
      status: 'failed',
      reason: outcome.error,
      provider: 'resend',
      providerResult: outcome.raw ?? null,
      completedAt: new Date(),
    });
    return null;
  });

  if (dispatch?.retryable) {
    throw new RetryableInfrastructureError(dispatch.retryable);
  }
}

function exhaustedOutboundMessage(reason: string) {
  const detail = reason.trim().slice(0, 200);
  return detail
    ? `Outbound send retries exhausted (${detail}).`
    : 'Outbound send retries exhausted after repeated provider failures.';
}

/**
 * When the queue dead-letters an `email.send` job, mark non-terminal outbound
 * rows failed (or reconcile as sent when a provider id was already recorded).
 */
export async function finalizeExhaustedOutboundJob(
  payload: Record<string, unknown>,
  reason: string,
) {
  const outboundId = typeof payload.outboundId === 'string' ? payload.outboundId : null;
  if (!outboundId) return;
  const inspectable = exhaustedOutboundMessage(reason);
  await db().transaction(async (tx) => {
    const row = (
      await tx
        .select()
        .from(outboundActions)
        .where(eq(outboundActions.id, outboundId))
        .for('update')
    ).at(0);
    if (!row) return;
    if (row.status === 'sent' || row.status === 'blocked' || row.status === 'failed') return;
    if (row.providerMessageId) {
      await markOutboundStatus(tx, outboundId, {
        status: 'sent',
        provider: row.provider ?? 'resend',
        providerMessageId: row.providerMessageId,
        providerResult: row.providerResult ?? { reconciled: true },
        completedAt: new Date(),
      });
      return;
    }
    await markOutboundStatus(tx, outboundId, {
      status: 'failed',
      reason: inspectable,
      completedAt: new Date(),
    });
  });
}

/**
 * Durable reconcile for dead `email.send` jobs whose onDeadLetter callback
 * previously failed. Idempotent: only touches queued/sending rows linked to dead jobs.
 */
export async function reconcileDeadOutboundJobs() {
  const inspectable = exhaustedOutboundMessage('reconciled after dead-letter callback failure');
  await db().execute(sql`
    UPDATE outbound_actions AS o
    SET
      status = CASE
        WHEN o.provider_message_id IS NOT NULL THEN 'sent'
        ELSE 'failed'
      END,
      reason = CASE
        WHEN o.provider_message_id IS NOT NULL THEN NULL
        ELSE ${inspectable}
      END,
      provider = CASE
        WHEN o.provider_message_id IS NOT NULL THEN coalesce(o.provider, 'resend')
        ELSE o.provider
      END,
      provider_result = CASE
        WHEN o.provider_message_id IS NOT NULL THEN coalesce(o.provider_result, '{"reconciled":true}'::jsonb)
        ELSE o.provider_result
      END,
      completed_at = coalesce(o.completed_at, now()),
      updated_at = now()
    WHERE o.status IN ('queued', 'sending')
      AND EXISTS (
        SELECT 1 FROM jobs AS j
        WHERE j.status = 'dead'
          AND j.type = ${EMAIL_SEND_JOB}
          AND (
            j.id = o.job_id
            OR j.payload->>'outboundId' = o.id::text
          )
      )
  `);
  await reconcileCancelledOutboundJobs();
}

/**
 * When lifecycle pause/stop cancels pending `email.send` jobs, mark linked
 * non-terminal outbound rows blocked so the Email tab does not stay on Queued.
 */
export async function finalizeOutboundForCancelledJobs(
  store: Tx,
  cancelledJobIds: string[],
  reason: string,
) {
  if (!cancelledJobIds.length) return;
  const now = new Date();
  const message = reason.trim().slice(0, 500) || 'Outbound send cancelled.';
  await store
    .update(outboundActions)
    .set({
      status: 'blocked',
      reason: message,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        inArray(outboundActions.jobId, cancelledJobIds),
        inArray(outboundActions.status, ['queued', 'sending']),
      ),
    );
}

/** Repair outbound rows whose send jobs were cancelled but never finalized. */
export async function reconcileCancelledOutboundJobs() {
  const reason = 'Outbound send cancelled before dispatch.';
  await db().execute(sql`
    UPDATE outbound_actions AS o
    SET
      status = 'blocked',
      reason = coalesce(nullif(o.reason, ''), ${reason}),
      completed_at = coalesce(o.completed_at, now()),
      updated_at = now()
    WHERE o.status IN ('queued', 'sending')
      AND o.provider_message_id IS NULL
      AND EXISTS (
        SELECT 1 FROM jobs AS j
        WHERE j.status = 'cancelled'
          AND j.type = ${EMAIL_SEND_JOB}
          AND (
            j.id = o.job_id
            OR j.payload->>'outboundId' = o.id::text
          )
      )
  `);
}
