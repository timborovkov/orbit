import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import { missingRecipientConsent } from '@/lib/policy/consent';
import { evaluateCandidate, loadPolicyContext } from '@/lib/policy/gateway';
import { resumeSimulationAfterApproval } from '@/lib/runtime/execute';
import { recordApprovalDecision } from '@/lib/runtime/telemetry';
import { actionIntents, agents, audit, policyDecisions, runs } from '@/lib/schema';

export type ReviewDecision = 'approved' | 'rejected';

type Tx = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0];

async function applyReviewInTransaction(
  tx: Tx,
  input: {
    actor: string;
    agentId: string;
    intentId: string;
    reviewStatus: ReviewDecision;
    editedPayload?: Record<string, unknown>;
    note?: string | null;
  },
): Promise<
  | { error: string }
  | {
      message: string;
      runId: string | null;
      endRun: boolean;
      agentName: string;
    }
> {
  const { actor, agentId, intentId, reviewStatus, editedPayload, note } = input;
  const agent = (
    await tx
      .select({
        id: agents.id,
        name: agents.name,
        approvalOnReject: agents.approvalOnReject,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .for('update')
  ).at(0);
  if (!agent) return { error: 'Agent not found.' };
  const intent = (
    await tx
      .select()
      .from(actionIntents)
      .where(and(eq(actionIntents.id, intentId), eq(actionIntents.agentId, agentId)))
      .for('update')
  ).at(0);
  if (intent?.reviewStatus !== 'pending') {
    return { error: 'This proposal is no longer awaiting review.' };
  }

  const ctx = await loadPolicyContext(agentId, actor, intent.runId, tx);
  if (!ctx) return { error: 'Agent not found.' };
  const consentFailure = await missingRecipientConsent(
    tx,
    agentId,
    intent.actionType,
    intent.recipients,
  );
  const policy = evaluateCandidate(
    ctx,
    {
      type: intent.actionType,
      idempotencyKey: intent.idempotencyKey,
      payload: editedPayload ?? intent.payload,
    },
    consentFailure,
  );

  const run = intent.runId
    ? (
        await tx
          .select({ id: runs.id, status: runs.status })
          .from(runs)
          .where(eq(runs.id, intent.runId))
          .for('update')
      ).at(0)
    : undefined;

  const approvalBlock =
    reviewStatus === 'approved'
      ? policy.decision === 'deny'
        ? policy.reasons.join(' ')
        : null
      : null;

  if (approvalBlock) {
    await tx.insert(policyDecisions).values({
      agentId,
      runId: intent.runId,
      actionType: intent.actionType,
      decision: 'deny',
      reasons: [approvalBlock],
      intentId,
      actor,
    });
    return { error: approvalBlock };
  }

  // With no write adapters, approved proposals remain suppressed until adapters exist.
  const decision = reviewStatus === 'approved' ? ('suppressed' as const) : ('deny' as const);
  const reason =
    reviewStatus === 'approved'
      ? editedPayload
        ? 'Administrator approved this proposal with edits.'
        : 'Administrator approved this proposal.'
      : 'Administrator rejected this proposal.';

  await tx.insert(policyDecisions).values({
    agentId,
    runId: intent.runId,
    actionType: intent.actionType,
    decision,
    reasons: [reason],
    intentId,
    actor,
  });

  const nextPayload = editedPayload ? { ...intent.payload, ...editedPayload } : intent.payload;
  await tx
    .update(actionIntents)
    .set({
      decision,
      reasons: [reason],
      payload: nextPayload,
      reviewStatus,
      reviewedBy: actor,
      reviewedAt: new Date(),
      reviewNote: note ?? null,
      reviewExpiresAt: null,
    })
    .where(eq(actionIntents.id, intentId));

  const endRun =
    reviewStatus === 'rejected' &&
    agent.approvalOnReject === 'end' &&
    run?.status === 'awaiting_approval'
      ? run
      : null;

  if (endRun) {
    await tx
      .update(runs)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        deferReason: 'Run ended after an administrator rejected a proposal.',
        result: sql`jsonb_set(
          coalesce(${runs.result}, '{"steps":[],"actions":[],"error":null}'::jsonb),
          '{error}',
          to_jsonb(${'Administrator rejected a required proposal.'}::text)
        )`,
      })
      .where(and(eq(runs.id, endRun.id), eq(runs.status, 'awaiting_approval')));
    await tx
      .update(actionIntents)
      .set({
        decision: 'deny',
        reasons: ['Run ended after an administrator rejected a proposal.'],
        reviewStatus: 'rejected',
        reviewedBy: actor,
        reviewedAt: new Date(),
        reviewExpiresAt: null,
      })
      .where(
        and(
          eq(actionIntents.runId, endRun.id),
          eq(actionIntents.reviewStatus, 'pending'),
          sql`${actionIntents.id} <> ${intentId}`,
        ),
      );
  }

  await tx.insert(audit).values({
    actor,
    action: `${reviewStatus === 'approved' ? 'Approved' : 'Rejected'} ${intent.actionType} for ${agent.name}`,
  });

  return {
    message:
      reviewStatus === 'approved'
        ? 'Proposal approved.'
        : endRun
          ? 'Proposal rejected; run ended.'
          : 'Proposal rejected.',
    runId: run?.status === 'awaiting_approval' && !endRun ? run.id : null,
    endRun: Boolean(endRun),
    agentName: agent.name,
  };
}

/** Shared review path for web mutations and tests (no server-only). */
export async function reviewProposedAction(
  actor: string,
  agentId: string,
  intentId: string,
  reviewStatus: ReviewDecision,
  options: { editedPayload?: Record<string, unknown>; note?: string | null } = {},
) {
  const result = await db().transaction((tx) =>
    applyReviewInTransaction(tx, {
      actor,
      agentId,
      intentId,
      reviewStatus,
      editedPayload: options.editedPayload,
      note: options.note,
    }),
  );
  if ('error' in result) return result;

  recordApprovalDecision({
    intentId,
    agentId,
    runId: result.runId,
    decision: reviewStatus,
  });

  if (result.runId) {
    await resumeSimulationAfterApproval(result.runId, actor);
  }

  return { message: result.message };
}

export async function reviewProposedActionsBulk(
  actor: string,
  items: { agentId: string; intentId: string }[],
  reviewStatus: ReviewDecision,
) {
  if (items.length === 0) return { error: 'Select at least one proposal.' as const };
  if (items.length > 50) return { error: 'Review at most 50 proposals at once.' as const };

  // Concurrent transactions; Postgres row locks serialize reviews of the same agent.
  const settled = await Promise.all(
    items.map(async (item) => {
      const result = await db().transaction((tx) =>
        applyReviewInTransaction(tx, {
          actor,
          agentId: item.agentId,
          intentId: item.intentId,
          reviewStatus,
        }),
      );
      if ('error' in result) {
        return {
          intentId: item.intentId,
          ok: false as const,
          message: result.error,
          runId: null as string | null,
        };
      }
      recordApprovalDecision({
        intentId: item.intentId,
        agentId: item.agentId,
        runId: result.runId,
        decision: reviewStatus,
      });
      return {
        intentId: item.intentId,
        ok: true as const,
        message: result.message,
        runId: result.runId,
      };
    }),
  );

  const resumeRuns = [...new Set(settled.flatMap((row) => (row.runId ? [row.runId] : [])))];
  await Promise.all(resumeRuns.map((runId) => resumeSimulationAfterApproval(runId, actor)));

  const failed = settled.filter((row) => !row.ok).length;
  const succeeded = settled.length - failed;
  return {
    message:
      failed === 0
        ? `${succeeded} proposal${succeeded === 1 ? '' : 's'} ${reviewStatus}.`
        : `${succeeded} succeeded, ${failed} failed.`,
    outcomes: settled.map(({ intentId, ok, message }) => ({ intentId, ok, message })),
  };
}

/**
 * Auto-reject pending approvals past review_expires_at.
 * Safe for the Bun worker (no React/server-only imports).
 */
export async function expireStaleApprovals(actor = 'system:approval-expiry') {
  const reason = 'Approval expired without an administrator decision.';
  const expired = await db().transaction(async (tx) => {
    const rows = await tx
      .select({
        id: actionIntents.id,
        agentId: actionIntents.agentId,
        runId: actionIntents.runId,
        actionType: actionIntents.actionType,
      })
      .from(actionIntents)
      .where(
        and(
          eq(actionIntents.reviewStatus, 'pending'),
          isNotNull(actionIntents.reviewExpiresAt),
          lt(actionIntents.reviewExpiresAt, new Date()),
        ),
      )
      .for('update')
      .limit(100);
    if (rows.length === 0) return rows;
    const ids = rows.map((row) => row.id);
    await tx
      .update(actionIntents)
      .set({
        decision: 'deny',
        reasons: [reason],
        reviewStatus: 'rejected',
        reviewedBy: actor,
        reviewedAt: new Date(),
        reviewExpiresAt: null,
        reviewNote: 'expired',
      })
      .where(inArray(actionIntents.id, ids));
    await tx.insert(policyDecisions).values(
      rows.map((row) => ({
        agentId: row.agentId,
        runId: row.runId,
        actionType: row.actionType,
        decision: 'deny' as const,
        reasons: [reason],
        intentId: row.id,
        actor,
      })),
    );
    return rows;
  });

  expired.forEach((row) => {
    recordApprovalDecision({
      intentId: row.id,
      agentId: row.agentId,
      runId: row.runId,
      decision: 'rejected',
    });
  });

  const runIds = [...new Set(expired.flatMap((row) => (row.runId ? [row.runId] : [])))];
  if (runIds.length === 0) return { expired: expired.length };

  const agentIds = [...new Set(expired.map((row) => row.agentId))];
  const agentRows = await db()
    .select({ id: agents.id, approvalOnReject: agents.approvalOnReject })
    .from(agents)
    .where(inArray(agents.id, agentIds));
  const onRejectByAgent = new Map(agentRows.map((row) => [row.id, row.approvalOnReject]));
  const endRunSet = new Set(
    runIds.filter((runId) => {
      const agentId = expired.find((row) => row.runId === runId)?.agentId;
      return agentId ? onRejectByAgent.get(agentId) === 'end' : false;
    }),
  );
  const endRuns = [...endRunSet];
  const resumeRuns = runIds.filter((runId) => !endRunSet.has(runId));

  if (endRuns.length) {
    await db()
      .update(runs)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        deferReason: 'Run ended after an approval expired.',
        result: sql`jsonb_set(
          coalesce(${runs.result}, '{"steps":[],"actions":[],"error":null}'::jsonb),
          '{error}',
          to_jsonb(${reason}::text)
        )`,
      })
      .where(and(inArray(runs.id, endRuns), eq(runs.status, 'awaiting_approval')));
    await db()
      .update(actionIntents)
      .set({
        decision: 'deny',
        reasons: ['Run ended after an approval expired.'],
        reviewStatus: 'rejected',
        reviewedBy: actor,
        reviewedAt: new Date(),
        reviewExpiresAt: null,
      })
      .where(and(inArray(actionIntents.runId, endRuns), eq(actionIntents.reviewStatus, 'pending')));
  }

  await Promise.all(resumeRuns.map((runId) => resumeSimulationAfterApproval(runId, actor)));
  return { expired: expired.length };
}
