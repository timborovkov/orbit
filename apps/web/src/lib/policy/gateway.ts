import { eq, sql } from 'drizzle-orm';

import {
  budgetViolationMessage,
  checkOutboundBudgets,
  checkRequestBudgets,
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
import { actionIntents, agents, controls, policyDecisions, usageCounters } from '@/lib/schema';

export type PolicyDecision = 'allow' | 'deny' | 'needs-approval' | 'suppressed';

export interface CandidateAction {
  type: string;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
  /** When true, this is a read-only tool invocation rather than an external write. */
  readOnly?: boolean;
}

export interface PolicyContext {
  actor: string;
  agentId: string;
  runId?: string | null;
  lifecycle: LifecycleState;
  enabledTools: string[];
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

function evaluateCandidate(
  ctx: PolicyContext,
  action: CandidateAction,
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
  const evaluated = evaluateCandidate(ctx, action);

  return await db().transaction(async (tx) => {
    const existing = (
      await tx
        .select()
        .from(actionIntents)
        .where(eq(actionIntents.idempotencyKey, action.idempotencyKey))
        .limit(1)
        .for('update')
    ).at(0);
    if (existing) {
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

export async function recordUsage(
  agentId: string,
  delta: { spendMicros?: bigint; requests?: number; outboundActions?: number },
  store: Store = db(),
) {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  await Promise.all(
    (
      [
        ['day', today],
        ['month', monthStart],
      ] as const
    ).map(async ([period, start]) => {
      await store
        .insert(usageCounters)
        .values({
          agentId,
          period,
          periodStart: start,
          spendMicros: delta.spendMicros ?? BigInt(0),
          requests: delta.requests ?? 0,
          outboundActions: delta.outboundActions ?? 0,
        })
        .onConflictDoUpdate({
          target: [usageCounters.agentId, usageCounters.period, usageCounters.periodStart],
          set: {
            spendMicros: sql`${usageCounters.spendMicros} + ${delta.spendMicros ?? BigInt(0)}`,
            requests: sql`${usageCounters.requests} + ${delta.requests ?? 0}`,
            outboundActions: sql`${usageCounters.outboundActions} + ${delta.outboundActions ?? 0}`,
          },
        });
    }),
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
