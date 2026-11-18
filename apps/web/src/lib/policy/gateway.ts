import { and, eq, sql } from 'drizzle-orm';

import {
  BudgetError,
  budgetViolationMessage,
  checkOutboundBudgets,
  checkRequestBudgets,
  hasSpendCap,
  parseBudgets,
  type BudgetSnapshot,
  type BudgetViolation,
} from '@/lib/budgets';
import { db, type Db, type Tx } from '@/lib/db';
import {
  canAcceptBackgroundWork,
  externalWritesPermitted,
  type LifecycleState,
} from '@/lib/lifecycle';
import { missingRecipientConsent } from '@/lib/policy/consent';
import { consentScope } from '@/lib/policy/scopes';
import { retryableStore } from '@/lib/runtime/errors';
import {
  actionIntents,
  agents,
  controls,
  policyDecisions,
  runs,
  usageCounters,
} from '@/lib/schema';

export type PolicyDecision = 'allow' | 'deny' | 'needs-approval' | 'suppressed';

export interface CandidateAction {
  type: string;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
  /** When true, this is a read-only tool invocation rather than an external write. */
  readOnly?: boolean;
  recipients?: string[];
  preliminary?: boolean;
  executionToken?: string;
}

export interface PolicyContext {
  actor: string;
  agentId: string;
  runId?: string | null;
  lifecycle: LifecycleState;
  enabledTools: string[];
  approvalTools?: string[];
  budgets: ReturnType<typeof parseBudgets>;
  globalPaused: boolean;
  usage: BudgetSnapshot['day'] & { month: BudgetSnapshot['month']; activeRuns: number };
}

export interface PolicyResult {
  decision: PolicyDecision;
  reasons: string[];
  intentId: string;
  violation?: BudgetViolation;
}

type Store = Db | Tx;

function emptyUsage() {
  return {
    spendMicros: BigInt(0),
    requests: 0,
    outboundActions: 0,
  };
}

export async function loadPolicyContext(
  agentId: string,
  actor: string,
  runId?: string | null,
  store: Store = db(),
): Promise<PolicyContext | null> {
  const agent = (await store.select().from(agents).where(eq(agents.id, agentId))).at(0);
  if (!agent) return null;
  const global = (await store.select().from(controls).where(eq(controls.id, 1))).at(0);
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const counters = await store
    .select()
    .from(usageCounters)
    .where(eq(usageCounters.agentId, agentId));
  const day = counters.find((row) => row.period === 'day' && row.periodStart === today);
  const month = counters.find((row) => row.period === 'month' && row.periodStart === monthStart);
  const active = await store.execute(sql`
    SELECT count(*)::int AS count FROM simulation_runs
    WHERE agent_id = ${agentId} AND status IN ('queued','running')
  `);
  const activeRows = Array.isArray(active) ? active : [];
  const first = activeRows[0] as { count?: number } | undefined;
  const activeRuns = first?.count ?? 0;

  return {
    actor,
    agentId,
    runId: runId ?? null,
    lifecycle: agent.lifecycle,
    enabledTools: Array.isArray(agent.enabledTools) ? agent.enabledTools : [],
    approvalTools: agent.approvalTools,
    budgets: parseBudgets(agent.budgets),
    globalPaused: global?.paused ?? true,
    usage: {
      ...(day
        ? {
            spendMicros: day.spendMicros,
            requests: day.requests,
            outboundActions: day.outboundActions,
          }
        : emptyUsage()),
      month: month
        ? {
            spendMicros: month.spendMicros,
            requests: month.requests,
            outboundActions: month.outboundActions,
          }
        : emptyUsage(),
      activeRuns,
    },
  };
}

export function evaluateCandidate(
  ctx: PolicyContext,
  action: CandidateAction,
  consentFailure: string | null = null,
): {
  decision: PolicyDecision;
  reasons: string[];
  violation?: BudgetViolation;
} {
  const reasons: string[] = [];

  if (ctx.globalPaused && !action.readOnly) {
    reasons.push('Global outbound pause is enabled.');
    return { decision: 'deny', reasons };
  }

  if (ctx.lifecycle === 'stopped') {
    reasons.push('Agent is stopped; external writes are blocked.');
    return { decision: 'deny', reasons };
  }

  if (ctx.lifecycle === 'paused') {
    reasons.push('Agent is paused.');
    return { decision: 'deny', reasons };
  }

  if (!action.readOnly && !canAcceptBackgroundWork(ctx.lifecycle)) {
    reasons.push(`Agent lifecycle ${ctx.lifecycle} does not accept this work.`);
    return { decision: 'deny', reasons };
  }

  if (ctx.enabledTools.length > 0 && !ctx.enabledTools.includes(action.type)) {
    reasons.push(`Tool ${action.type} is not enabled for this agent.`);
    return { decision: 'deny', reasons };
  }

  const snapshot: BudgetSnapshot = {
    budgets: ctx.budgets,
    day: {
      spendMicros: ctx.usage.spendMicros,
      requests: ctx.usage.requests,
      outboundActions: ctx.usage.outboundActions,
    },
    month: ctx.usage.month,
    activeRuns: ctx.usage.activeRuns,
  };

  if (!action.readOnly) {
    const outbound = checkOutboundBudgets(snapshot);
    if (outbound) {
      reasons.push(budgetViolationMessage(outbound));
      return { decision: 'deny', reasons, violation: outbound };
    }

    if (consentFailure) return { decision: 'deny', reasons: [consentFailure] };
    if (
      !action.preliminary &&
      (consentScope.safeParse(action.type).success || ctx.approvalTools?.includes(action.type))
    ) {
      return {
        decision: 'needs-approval',
        reasons: ['An administrator must review this proposal.'],
      };
    }

    // No external write adapters exist yet. Persist the intent and suppress dispatch.
    // Live remains a first-class state so activation can unlock adapters later.
    if (!externalWritesPermitted(ctx.lifecycle)) {
      reasons.push('Shadow mode suppresses external writes. Proposal logged only.');
      return { decision: 'suppressed', reasons };
    }
    reasons.push(
      'Live mode is active, but no external action adapters are configured yet. Proposal suppressed.',
    );
    return { decision: 'suppressed', reasons };
  }

  const requestLimit = checkRequestBudgets(snapshot);
  if (requestLimit) {
    reasons.push(budgetViolationMessage(requestLimit));
    return { decision: 'deny', reasons, violation: requestLimit };
  }

  reasons.push('Read-only tool permitted within budgets.');
  return { decision: 'allow', reasons };
}

/**
 * Single choke point for candidate actions. Always stores an action intent and
 * idempotency key before any dispatch would occur, then records the decision
 * in the same transaction so retries cannot leave intent without audit.
 */
export async function authorizeAction(
  ctx: PolicyContext,
  action: CandidateAction,
): Promise<PolicyResult> {
  return await db().transaction(async (tx) => {
    // Serialize against lifecycle changes, consent changes, and competing reviews.
    const agent = (
      await tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, ctx.agentId))
        .for('update')
    ).at(0);
    const current = agent && (await loadPolicyContext(ctx.agentId, ctx.actor, ctx.runId, tx));
    if (!current) throw new BudgetError('cancelled');
    if (action.executionToken && ctx.runId) {
      const owned = (
        await tx
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.id, ctx.runId),
              eq(runs.agentId, ctx.agentId),
              eq(runs.executionToken, action.executionToken),
              eq(runs.status, 'running'),
            ),
          )
      ).at(0);
      if (!owned) throw new BudgetError('cancelled');
    }
    const recipients = action.recipients ?? [];
    const consentFailure = action.readOnly
      ? null
      : await missingRecipientConsent(tx, ctx.agentId, action.type, recipients);
    const evaluated = evaluateCandidate(current, action, consentFailure);
    const existing = (
      await tx
        .select()
        .from(actionIntents)
        .where(
          and(
            eq(actionIntents.agentId, ctx.agentId),
            eq(actionIntents.idempotencyKey, action.idempotencyKey),
          ),
        )
        .limit(1)
        .for('update')
    ).at(0);
    if (existing) {
      if (evaluated.decision === 'deny' && existing.decision !== 'deny') {
        // Record the fresh policy outcome without rewriting the original human decision.
        await tx.insert(policyDecisions).values({
          agentId: current.agentId,
          runId: current.runId,
          actionType: action.type,
          decision: evaluated.decision,
          reasons: evaluated.reasons,
          intentId: existing.id,
          actor: current.actor,
        });
        return { ...evaluated, intentId: existing.id };
      }
      const audit = (
        await tx
          .select({ id: policyDecisions.id })
          .from(policyDecisions)
          .where(eq(policyDecisions.intentId, existing.id))
          .limit(1)
      ).at(0);
      if (!audit) {
        await tx.insert(policyDecisions).values({
          agentId: ctx.agentId,
          runId: ctx.runId ?? null,
          actionType: action.type,
          decision: existing.decision,
          reasons: Array.isArray(existing.reasons) ? existing.reasons : [],
          intentId: existing.id,
          actor: ctx.actor,
        });
      }
      return {
        decision: existing.decision as PolicyDecision,
        reasons: Array.isArray(existing.reasons) ? existing.reasons : [],
        intentId: existing.id,
      };
    }

    const intent = (
      await tx
        .insert(actionIntents)
        .values({
          agentId: ctx.agentId,
          runId: ctx.runId ?? null,
          actionType: action.type,
          payload: action.payload ?? {},
          recipients,
          reviewStatus: evaluated.decision === 'needs-approval' ? 'pending' : null,
          idempotencyKey: action.idempotencyKey,
          decision: evaluated.decision,
          reasons: evaluated.reasons,
        })
        .returning()
    ).at(0);
    if (!intent) throw new Error('Failed to persist action intent');

    await tx.insert(policyDecisions).values({
      agentId: ctx.agentId,
      runId: ctx.runId ?? null,
      actionType: action.type,
      decision: evaluated.decision,
      reasons: evaluated.reasons,
      intentId: intent.id,
      actor: ctx.actor,
    });

    return {
      decision: evaluated.decision,
      reasons: evaluated.reasons,
      intentId: intent.id,
      violation: evaluated.violation,
    };
  });
}

async function recordRequestUsage(
  store: Tx,
  agentId: string,
  today: string,
  spendMicros: bigint,
  requests: number,
) {
  await store
    .insert(usageCounters)
    .values([
      { agentId, period: 'day', periodStart: today, spendMicros, requests },
      { agentId, period: 'month', periodStart: `${today.slice(0, 7)}-01`, spendMicros, requests },
    ])
    .onConflictDoUpdate({
      target: [usageCounters.agentId, usageCounters.period, usageCounters.periodStart],
      set: {
        spendMicros: sql`${usageCounters.spendMicros} + ${spendMicros}`,
        requests: sql`${usageCounters.requests} + ${requests}`,
      },
    });
}

/** Check the current budgets and reserve before dispatch, under the same agent lock as Stop. */
export async function reserveRequestQuota(
  agentId: string,
  upperBoundMicros?: number,
  execution?: {
    runId: string;
    token: string;
    signal: AbortSignal;
    /** When set, reservation is idempotent per run+stage across queue retries. */
    stage?: 'evaluator' | 'main';
  },
) {
  const requestedMicros = BigInt(upperBoundMicros ?? 0);
  const outcome = await retryableStore(() =>
    db().transaction(async (tx) => {
      const agent = (await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')).at(
        0,
      );
      if (!agent || agent.lifecycle === 'stopped' || execution?.signal.aborted) {
        throw new BudgetError('cancelled');
      }
      let runRow:
        | {
            id: string;
            result: (typeof runs)['$inferSelect']['result'];
          }
        | undefined;
      if (execution) {
        runRow = (
          await tx
            .select({ id: runs.id, result: runs.result })
            .from(runs)
            .where(
              and(
                eq(runs.id, execution.runId),
                eq(runs.agentId, agentId),
                eq(runs.status, 'running'),
                eq(runs.executionToken, execution.token),
                sql`${runs.expiresAt} > now()`,
              ),
            )
            .for('update')
        ).at(0);
        if (!runRow) throw new BudgetError('cancelled');
      }
      const budgets = parseBudgets(agent.budgets);
      const today = new Date().toISOString().slice(0, 10);
      const monthStart = `${today.slice(0, 7)}-01`;
      const counters = await tx
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.agentId, agentId));
      const day =
        counters.find((row) => row.period === 'day' && row.periodStart === today) ?? emptyUsage();
      const month =
        counters.find((row) => row.period === 'month' && row.periodStart === monthStart) ??
        emptyUsage();
      if (upperBoundMicros === undefined && hasSpendCap(budgets))
        throw new BudgetError('unknown-price');

      if (execution?.stage && runRow) {
        const existing = runRow.result.quotaReservations?.find(
          (entry) => entry.stage === execution.stage,
        );
        if (existing) {
          // Settle against the original accounting day, not the retry's UTC date.
          const periodStart = existing.periodStart;
          const reservationMonthStart = `${periodStart.slice(0, 7)}-01`;
          const reservationDay =
            counters.find((row) => row.period === 'day' && row.periodStart === periodStart) ??
            emptyUsage();
          const reservationMonth =
            counters.find(
              (row) => row.period === 'month' && row.periodStart === reservationMonthStart,
            ) ?? emptyUsage();
          let reservedMicros = BigInt(existing.reservedMicros);
          let reservation = existing;
          if (requestedMicros > reservedMicros) {
            const additional = requestedMicros - reservedMicros;
            // Request count stays idempotent; validate/top up against the original period.
            for (const [period, used, cap] of [
              ['daily-spend', reservationDay.spendMicros, budgets.dailySpendCents],
              ['monthly-spend', reservationMonth.spendMicros, budgets.monthlySpendCents],
            ] as const) {
              if (cap === null) continue;
              const limit = BigInt(cap) * BigInt(10_000);
              if (used >= limit || used + additional > limit) {
                throw new BudgetError(period);
              }
            }
            await recordRequestUsage(tx, agentId, periodStart, additional, 0);
            reservation = {
              stage: execution.stage,
              reservedMicros: requestedMicros.toString(),
              periodStart,
            };
            const quotaReservations = [
              ...(runRow.result.quotaReservations ?? []).filter(
                (entry) => entry.stage !== execution.stage,
              ),
              reservation,
            ];
            await tx
              .update(runs)
              .set({ result: { ...runRow.result, quotaReservations } })
              .where(eq(runs.id, runRow.id));
            reservedMicros = requestedMicros;
          }
          return {
            today: periodStart,
            reservedMicros,
            reservation,
            reused: true as const,
          };
        }
      }

      const violation = checkRequestBudgets(
        { budgets, day, month, activeRuns: 0 },
        requestedMicros,
      );
      if (violation) throw new BudgetError(violation);
      await recordRequestUsage(tx, agentId, today, requestedMicros, 1);
      const reservation =
        execution?.stage !== undefined
          ? {
              stage: execution.stage,
              reservedMicros: requestedMicros.toString(),
              periodStart: today,
            }
          : undefined;
      if (runRow && reservation) {
        const quotaReservations = [...(runRow.result.quotaReservations ?? []), reservation];
        await tx
          .update(runs)
          .set({ result: { ...runRow.result, quotaReservations } })
          .where(eq(runs.id, runRow.id));
      }
      return {
        today,
        reservedMicros: requestedMicros,
        reservation,
        reused: false as const,
      };
    }),
  );

  // Keep the full reservation after ambiguous failures or missing costs. Settlement is attempted
  // once per dispatch, so a connection loss during commit cannot double-apply the adjustment.
  return Object.assign(
    async (billedMicros: number) => {
      const adjustment = BigInt(billedMicros) - outcome.reservedMicros;
      if (adjustment !== BigInt(0)) {
        await db().transaction((tx) =>
          recordRequestUsage(tx, agentId, outcome.today, adjustment, 0),
        );
      }
    },
    { reservation: outcome.reservation, reused: outcome.reused },
  );
}

/** Pure evaluation helper for unit tests without persistence. */
export function evaluateActionForTest(
  ctx: Omit<PolicyContext, 'actor' | 'agentId' | 'runId' | 'usage'> & {
    usage?: PolicyContext['usage'];
  },
  action: CandidateAction,
) {
  return evaluateCandidate(
    {
      actor: 'test',
      agentId: '00000000-0000-0000-0000-000000000000',
      runId: null,
      usage: ctx.usage ?? {
        ...emptyUsage(),
        month: emptyUsage(),
        activeRuns: 0,
      },
      ...ctx,
    },
    action,
  );
}
