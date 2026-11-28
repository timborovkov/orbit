import { and, eq, inArray, sql } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import { recipientConsentFailure } from '@/lib/policy/consent';
import { evaluateCandidate, loadPolicyContext } from '@/lib/policy/gateway';
import type { JobRecord } from '@/lib/queue/types';
import { lockApprovalAgent } from '@/lib/runtime/approval-work';
import { channelAction, channelOutboundJobTypes } from '@/lib/runtime/channels/registry';
import type { ChannelAction } from '@/lib/runtime/channels/types';
import { RetryableInfrastructureError } from '@/lib/runtime/errors';
import { INTRODUCTION_REVIEW } from '@/lib/runtime/introductions/types';
import {
  claimOutboundForSending,
  loadOutboundForDispatch,
  markOutboundStatus,
  recordOutboundUsage,
} from '@/lib/runtime/outbound/dispatch';
import { CHANNEL_OUTBOUND_JOB } from '@/lib/runtime/outbound/types';
import { actionIntents, controls, jobs, outboundActions, policyDecisions } from '@/lib/schema';

const uncertainDelivery =
  'Delivery could not be confirmed. Check the original post before taking further action.';

async function lockOwnedJob(tx: Tx, job: JobRecord, outboundId: string) {
  const [row] = await tx.select().from(jobs).where(eq(jobs.id, job.id)).for('update');
  if (!row || row.type !== job.type || row.payload.outboundId !== outboundId) return null;
  if (row.status === 'cancelled') return row;
  return row.status === 'claimed' &&
    job.claimedBy &&
    row.claimedBy === job.claimedBy &&
    row.attempts === job.attempts &&
    row.claimExpiresAt &&
    row.claimExpiresAt > new Date()
    ? row
    : null;
}

async function reserveNonIdempotentDelivery(
  job: JobRecord,
  outbound: typeof outboundActions.$inferSelect,
) {
  return db().transaction(async (tx) => {
    await lockApprovalAgent(tx, outbound.agentId);
    const jobRow = await lockOwnedJob(tx, job, outbound.id);
    if (jobRow?.status !== 'claimed') return false;
    const [row] = await tx
      .select()
      .from(outboundActions)
      .where(eq(outboundActions.id, outbound.id))
      .for('update');
    if (!row || row.jobId !== job.id) return false;
    if (row.status === 'sending' && !row.providerMessageId) {
      if (row.dispatchAttempt !== job.attempts) {
        await markOutboundStatus(tx, row.id, {
          status: 'failed',
          reason: uncertainDelivery,
          completedAt: new Date(),
        });
      }
      return false;
    }
    if (row.status !== 'queued') return false;
    await markOutboundStatus(tx, row.id, {
      status: 'sending',
      dispatchAttempt: job.attempts,
      dispatchedAt: new Date(),
    });
    return true;
  });
}

export async function processOutboundJob(
  job: JobRecord,
  signal: AbortSignal,
  override?: { actionType: string; prepareDelivery: ChannelAction['prepareDelivery'] },
) {
  const { outboundId } = job.payload;
  const actor = typeof job.payload.actor === 'string' ? job.payload.actor : 'system:outbound';
  if (typeof outboundId !== 'string') throw new Error('Outbound job missing outboundId');
  const loaded = await loadOutboundForDispatch(outboundId);
  if (!loaded) return;
  const { outbound } = loaded;
  const handler = channelAction(outbound.actionType)?.action;
  if (override && override.actionType !== outbound.actionType) return;
  if (handler && job.type !== (handler.jobType ?? CHANNEL_OUTBOUND_JOB)) return;
  const prepare = override?.prepareDelivery ?? handler?.prepareDelivery;
  const nonIdempotent = handler?.requiresDispatchMarker;
  // Commit before attempting a provider call whose outcome can be ambiguous.
  if (nonIdempotent && !(await reserveNonIdempotentDelivery(job, outbound))) return;

  // Agent and controls locks serialize the final policy check with pause/stop.
  const dispatch = await db().transaction(async (tx) => {
    await lockApprovalAgent(tx, outbound.agentId);
    await tx.select().from(controls).where(eq(controls.id, 1)).for('update');
    const jobRow = await lockOwnedJob(tx, job, outbound.id);
    if (!jobRow || (outbound.jobId !== null && outbound.jobId !== job.id)) return null;
    const claimed = await claimOutboundForSending(tx, outbound.id);
    if (!claimed) return null;
    const { row } = claimed;
    if (row.jobId !== null && row.jobId !== job.id) return null;
    if (claimed.alreadySent) {
      if (claimed.reconciled && row.providerMessageId) {
        await markOutboundStatus(tx, row.id, {
          status: 'sent',
          provider: row.provider ?? handler?.provider ?? null,
          providerMessageId: row.providerMessageId,
          providerResult: row.providerResult ?? { reconciled: true },
          completedAt: new Date(),
        });
      }
      return null;
    }
    if ('terminal' in claimed && claimed.terminal) return null;
    if (nonIdempotent && row.dispatchAttempt !== job.attempts) return null;
    const block = (reason: string) =>
      markOutboundStatus(tx, row.id, {
        status: 'blocked',
        reason:
          handler?.idempotencyWindowMs && job.attempts > 1
            ? `${reason} An earlier attempt may have reached the provider. Check the provider outcome.`
            : reason,
        completedAt: new Date(),
      });
    if (jobRow.status === 'cancelled') {
      await block('Outbound send cancelled before dispatch.');
      return null;
    }
    const [intent] = await tx
      .select()
      .from(actionIntents)
      .where(and(eq(actionIntents.id, row.intentId), eq(actionIntents.agentId, row.agentId)));
    if (
      !intent ||
      intent.actionType !== row.actionType ||
      intent.actionType === INTRODUCTION_REVIEW ||
      (intent.reviewStatus !== null && intent.reviewStatus !== 'approved') ||
      intent.decision !== 'allow' ||
      (handler?.alwaysRequiresApproval && intent.reviewStatus !== 'approved')
    ) {
      await block('Proposal was not authorized for dispatch.');
      return null;
    }
    if (!handler || !prepare) {
      await block('No outbound adapter is available for this action.');
      return null;
    }
    const delivery = await prepare(tx, row, intent);
    if ('error' in delivery) {
      await tx.insert(policyDecisions).values({
        agentId: row.agentId,
        actionType: row.actionType,
        intentId: intent.id,
        actor,
        decision: 'deny',
        reasons: [delivery.error],
      });
      await block(delivery.error);
      return null;
    }

    const ctx = await loadPolicyContext(row.agentId, actor, intent.runId, tx, {
      currentApproval: intent.reviewStatus === null,
    });
    if (!ctx) {
      await block('Agent unavailable for dispatch policy checks.');
      return null;
    }
    const consent = await recipientConsentFailure(
      tx,
      row.agentId,
      row.actionType,
      delivery.recipients,
      ctx.consentRequiredTools,
    );
    const policy = evaluateCandidate(
      ctx,
      {
        type: row.actionType,
        idempotencyKey: row.idempotencyKey,
        payload: intent.payload,
        recipients: delivery.recipients,
      },
      consent,
      false,
      { skipApproval: intent.reviewStatus === 'approved' },
    );
    const audit = {
      agentId: row.agentId,
      runId: intent.runId,
      actionType: row.actionType,
      intentId: intent.id,
      actor,
    };
    if (policy.decision !== 'allow') {
      await tx
        .insert(policyDecisions)
        .values({ ...audit, decision: policy.decision, reasons: policy.reasons });
      await block(policy.reasons.join(' ') || 'Dispatch blocked by policy.');
      return null;
    }

    if (signal.aborted && nonIdempotent) {
      await markOutboundStatus(tx, row.id, {
        status: 'queued',
        dispatchedAt: null,
        dispatchAttempt: null,
      });
      return { retryable: 'Worker stopped before delivery.' };
    }
    if (
      handler.idempotencyWindowMs &&
      job.attempts > 1 &&
      Date.now() - (row.dispatchedAt ?? row.createdAt).getTime() >= handler.idempotencyWindowMs
    ) {
      await markOutboundStatus(tx, row.id, {
        status: 'failed',
        reason:
          'The provider retry window expired. Check the provider outcome before sending again.',
        completedAt: new Date(),
      });
      return null;
    }
    signal.throwIfAborted();
    const provider = delivery.provider ?? handler.provider;
    const outcome = await delivery.send(signal).catch(async (error: unknown) => {
      if (!nonIdempotent) throw error;
      await markOutboundStatus(tx, row.id, {
        status: 'failed',
        reason: uncertainDelivery,
        provider,
        providerResult: { outcome: 'uncertain' },
        completedAt: new Date(),
      });
      return null;
    });
    if (!outcome) return null;
    if (outcome.ok) {
      await markOutboundStatus(tx, row.id, {
        status: 'sent',
        reason: null,
        provider,
        providerMessageId: outcome.id,
        providerResult: outcome.raw,
        completedAt: new Date(),
      });
      await recordOutboundUsage(tx, row.agentId);
      await tx
        .insert(policyDecisions)
        .values({ ...audit, decision: 'allow', reasons: ['Outbound action sent.'] });
      return null;
    }
    if (outcome.retryable && (!nonIdempotent || job.attempts < job.maxAttempts)) {
      if (nonIdempotent) {
        await markOutboundStatus(tx, row.id, {
          status: 'queued',
          provider,
          reason: outcome.error,
          providerResult: outcome.raw ?? null,
          dispatchAttempt: null,
          dispatchedAt: null,
        });
      }
      return { retryable: outcome.error };
    }
    await markOutboundStatus(tx, row.id, {
      status: 'failed',
      reason: outcome.error,
      provider,
      providerResult: outcome.raw ?? null,
      completedAt: new Date(),
    });
    return null;
  });
  if (dispatch?.retryable) throw new RetryableInfrastructureError(dispatch.retryable);
}

function exhaustedOutboundMessage(reason: string) {
  const detail = reason.trim().slice(0, 200);
  return detail
    ? `Outbound send retries exhausted (${detail}).`
    : 'Outbound send retries exhausted after repeated provider failures.';
}

/**
 * When the queue dead-letters an outbound job, mark non-terminal outbound
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
        provider: row.provider ?? channelAction(row.actionType)?.action.provider ?? null,
        providerMessageId: row.providerMessageId,
        providerResult: row.providerResult ?? { reconciled: true },
        completedAt: new Date(),
      });
      return;
    }
    await markOutboundStatus(tx, outboundId, {
      status: 'failed',
      reason:
        row.status === 'sending' && row.dispatchAttempt !== null ? uncertainDelivery : inspectable,
      completedAt: new Date(),
    });
  });
}

/**
 * Durable reconcile for dead outbound jobs whose onDeadLetter callback
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
        WHEN o.status = 'sending' AND o.dispatch_attempt IS NOT NULL THEN ${uncertainDelivery}
        ELSE ${inspectable}
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
          AND j.type IN (${sql.join(
            channelOutboundJobTypes().map((type) => sql`${type}`),
            sql`, `,
          )})
          AND (
            j.id = o.job_id
            OR j.payload->>'outboundId' = o.id::text
          )
      )
  `);
  await reconcileCancelledOutboundJobs();
}

/**
 * When lifecycle pause/stop cancels pending outbound jobs, mark linked
 * non-terminal outbound rows blocked so the activity does not stay queued.
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
      status: sql`CASE WHEN ${outboundActions.status} = 'sending' AND ${outboundActions.dispatchAttempt} IS NOT NULL THEN 'failed' ELSE 'blocked' END`,
      reason: sql`CASE WHEN ${outboundActions.status} = 'sending' AND ${outboundActions.dispatchAttempt} IS NOT NULL THEN ${uncertainDelivery} ELSE ${message} END`,
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
      status = CASE WHEN o.status = 'sending' AND o.dispatch_attempt IS NOT NULL THEN 'failed' ELSE 'blocked' END,
      reason = CASE WHEN o.status = 'sending' AND o.dispatch_attempt IS NOT NULL THEN ${uncertainDelivery} ELSE coalesce(nullif(o.reason, ''), ${reason}) END,
      completed_at = coalesce(o.completed_at, now()),
      updated_at = now()
    WHERE o.status IN ('queued', 'sending')
      AND o.provider_message_id IS NULL
      AND EXISTS (
        SELECT 1 FROM jobs AS j
        WHERE j.status = 'cancelled'
          AND j.type IN (${sql.join(
            channelOutboundJobTypes().map((type) => sql`${type}`),
            sql`, `,
          )})
          AND (
            j.id = o.job_id
            OR j.payload->>'outboundId' = o.id::text
          )
      )
  `);
}
