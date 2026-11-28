import { and, eq, sql } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import { enqueueJob } from '@/lib/queue/jobs';
import { channelAction } from '@/lib/runtime/channels/registry';
import type { ActionIntent } from '@/lib/runtime/channels/types';
import { INTRODUCTION_REVIEW } from '@/lib/runtime/introductions/types';
import { CHANNEL_OUTBOUND_JOB, type OutboundActionStatus } from '@/lib/runtime/outbound/types';
import { actionIntents, outboundActions, usageCounters } from '@/lib/schema';

/** Queue a policy-approved intent while holding the agent lock. */
export async function enqueueOutbound(
  tx: Tx,
  intent: ActionIntent,
  actor: string,
): Promise<{ outboundId: string; jobId: string; status: OutboundActionStatus } | null> {
  const adapter = channelAction(intent.actionType)?.action;
  if (
    !adapter ||
    intent.actionType === INTRODUCTION_REVIEW ||
    intent.decision !== 'allow' ||
    (adapter.alwaysRequiresApproval && intent.reviewStatus !== 'approved')
  )
    return null;
  const body = typeof intent.payload.draft === 'string' ? intent.payload.draft.trim() : '';

  const existing = (
    await tx
      .select()
      .from(outboundActions)
      .where(eq(outboundActions.idempotencyKey, intent.idempotencyKey))
      .for('update')
  ).at(0);
  if (existing) {
    return {
      outboundId: existing.id,
      jobId: existing.jobId ?? '',
      status: existing.status,
    };
  }

  const byIntent = (
    await tx
      .select()
      .from(outboundActions)
      .where(eq(outboundActions.intentId, intent.id))
      .for('update')
  ).at(0);
  if (byIntent) {
    return {
      outboundId: byIntent.id,
      jobId: byIntent.jobId ?? '',
      status: byIntent.status,
    };
  }

  const outbound = (
    await tx
      .insert(outboundActions)
      .values({
        agentId: intent.agentId,
        intentId: intent.id,
        actionType: intent.actionType,
        status: 'queued',
        reason: null,
        idempotencyKey: intent.idempotencyKey,
        body,
        ...adapter.legacyReferences?.(intent),
      })
      .returning()
  ).at(0);
  if (!outbound) throw new Error('Failed to persist outbound action');

  const job = await enqueueJob(tx, {
    type: adapter.jobType ?? CHANNEL_OUTBOUND_JOB,
    payload: {
      outboundId: outbound.id,
      intentId: intent.id,
      agentId: intent.agentId,
      actor,
    },
    idempotencyKey: `outbound:${intent.idempotencyKey}`,
    maxAttempts: 5,
  });

  await tx
    .update(outboundActions)
    .set({ jobId: job.id, updatedAt: new Date() })
    .where(eq(outboundActions.id, outbound.id));

  return { outboundId: outbound.id, jobId: job.id, status: 'queued' };
}

export async function markOutboundStatus(
  store: Tx,
  outboundId: string,
  update: {
    status: OutboundActionStatus;
    reason?: string | null;
    provider?: string | null;
    providerMessageId?: string | null;
    providerResult?: Record<string, unknown> | null;
    dispatchedAt?: Date | null;
    dispatchAttempt?: number | null;
    completedAt?: Date | null;
  },
) {
  const now = new Date();
  await store
    .update(outboundActions)
    .set({
      status: update.status,
      updatedAt: now,
      ...(update.reason !== undefined ? { reason: update.reason } : {}),
      ...(update.provider !== undefined ? { provider: update.provider } : {}),
      ...(update.providerMessageId !== undefined
        ? { providerMessageId: update.providerMessageId }
        : {}),
      ...(update.providerResult !== undefined ? { providerResult: update.providerResult } : {}),
      ...(update.dispatchedAt !== undefined ? { dispatchedAt: update.dispatchedAt } : {}),
      ...(update.dispatchAttempt !== undefined ? { dispatchAttempt: update.dispatchAttempt } : {}),
      ...(update.completedAt !== undefined ? { completedAt: update.completedAt } : {}),
    })
    .where(eq(outboundActions.id, outboundId));
}

/** Increment outbound usage counters after a successful external send. */
export async function recordOutboundUsage(store: Tx, agentId: string, count = 1) {
  const today = new Date().toISOString().slice(0, 10);
  await store
    .insert(usageCounters)
    .values([
      {
        agentId,
        period: 'day',
        periodStart: today,
        outboundActions: count,
      },
      {
        agentId,
        period: 'month',
        periodStart: `${today.slice(0, 7)}-01`,
        outboundActions: count,
      },
    ])
    .onConflictDoUpdate({
      target: [usageCounters.agentId, usageCounters.period, usageCounters.periodStart],
      set: {
        outboundActions: sql`${usageCounters.outboundActions} + ${count}`,
      },
    });
}

export async function loadOutboundForDispatch(outboundId: string, store = db()) {
  return (
    await store
      .select({
        outbound: outboundActions,
        intent: actionIntents,
      })
      .from(outboundActions)
      .innerJoin(actionIntents, eq(actionIntents.id, outboundActions.intentId))
      .where(eq(outboundActions.id, outboundId))
      .limit(1)
  ).at(0);
}

export async function claimOutboundForSending(tx: Tx, outboundId: string) {
  const row = (
    await tx.select().from(outboundActions).where(eq(outboundActions.id, outboundId)).for('update')
  ).at(0);
  if (!row) return null;
  if (row.status === 'sent') return { row, alreadySent: true as const };
  if (row.status === 'blocked' || row.status === 'failed') {
    return { row, alreadySent: false as const, terminal: true as const };
  }
  if (row.status === 'sending' && row.providerMessageId) {
    return { row, alreadySent: true as const, reconciled: true as const };
  }
  await tx
    .update(outboundActions)
    .set({
      status: 'sending',
      dispatchedAt: row.dispatchedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(outboundActions.id, outboundId), eq(outboundActions.status, row.status)));
  return { row: { ...row, status: 'sending' as const }, alreadySent: false as const };
}
