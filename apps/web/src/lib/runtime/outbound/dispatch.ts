import { and, eq, sql } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import { enqueueJob } from '@/lib/queue/jobs';
import {
  EMAIL_SEND_ACTION,
  EMAIL_SEND_JOB,
  hasWriteAdapter,
  type OutboundActionStatus,
} from '@/lib/runtime/outbound/types';
import { actionIntents, outboundActions, usageCounters } from '@/lib/schema';

/**
 * Persist a durable outbound action and enqueue its worker job after an
 * administrator approval that evaluated to `allow`. Shared by email.send and
 * future adapters. Caller must hold the agent lock and have already recorded
 * the approval decision on the intent.
 */
export async function enqueueApprovedOutbound(
  tx: Tx,
  input: {
    agentId: string;
    intentId: string;
    actionType: string;
    body: string;
    idempotencyKey: string;
    emailMessageId?: string | null;
    threadId?: string | null;
    actor: string;
  },
): Promise<{ outboundId: string; jobId: string; status: OutboundActionStatus } | null> {
  if (!hasWriteAdapter(input.actionType)) return null;
  if (input.actionType !== EMAIL_SEND_ACTION) return null;

  const body = input.body.trim();
  if (!body) return null;

  const existing = (
    await tx
      .select()
      .from(outboundActions)
      .where(eq(outboundActions.idempotencyKey, input.idempotencyKey))
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
      .where(eq(outboundActions.intentId, input.intentId))
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
        agentId: input.agentId,
        intentId: input.intentId,
        actionType: input.actionType,
        status: 'queued',
        reason: null,
        idempotencyKey: input.idempotencyKey,
        body,
        emailMessageId: input.emailMessageId ?? null,
        threadId: input.threadId ?? null,
      })
      .returning()
  ).at(0);
  if (!outbound) throw new Error('Failed to persist outbound action');

  const job = await enqueueJob(tx, {
    type: EMAIL_SEND_JOB,
    payload: {
      outboundId: outbound.id,
      intentId: input.intentId,
      agentId: input.agentId,
      actor: input.actor,
    },
    idempotencyKey: `outbound:${input.idempotencyKey}`,
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
