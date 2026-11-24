import { and, eq, inArray, sql } from 'drizzle-orm';

import { notifyApprovalPending } from '@/lib/approvals/notify';
import { actionNeedsApproval, mergeApprovalTools } from '@/lib/approvals/rules';
import {
  BudgetError,
  type BudgetSnapshot,
  type BudgetViolation,
  budgetViolationMessage,
  checkOutboundBudgets,
  checkRequestBudgets,
  hasSpendCap,
  parseBudgets,
} from '@/lib/budgets';
import { type Db, db, type Tx } from '@/lib/db';
import { KNOWLEDGE_SEARCH_TOOL } from '@/lib/knowledge/types';
import { canAcceptBackgroundWork, type LifecycleState } from '@/lib/lifecycle';
import { mcpToolId, mcpToolIsReadOnly, normalizeMcpAllowlist } from '@/lib/mcp-allowlist';
import { recipientConsentFailure } from '@/lib/policy/consent';
import { type ExecutionContext, executionContextForOrigin } from '@/lib/policy/execution-context';
import { authorizeOutboundDispatch } from '@/lib/policy/outbound';
import type { ConsentScope } from '@/lib/policy/scopes';
import { isWebTool, WEB_CRAWL } from '@/lib/research';
import { channelAction, channelAdapter, channelForRun } from '@/lib/runtime/channels/registry';
import { retryableStore } from '@/lib/runtime/errors';
import { isCommitmentTool } from '@/lib/runtime/follow-ups/types';
import { PEOPLE_INTRODUCE, peopleGrant } from '@/lib/runtime/introductions/types';
import {
  HISTORY_SEARCH,
  MEMORY_CAPTURE,
  MEMORY_SEARCH,
  memoryCaptureOrigin,
} from '@/lib/runtime/memory/types';
import { crawlAllowed, publicPageUrl } from '@/lib/runtime/research/urls';
import { countCompetingActiveRuns } from '@/lib/runtime/run-lanes';
import {
  actionIntents,
  agentMcpConnections,
  agents,
  configurations,
  controls,
  mcpConnections,
  type McpTransport,
  policyDecisions,
  runMemoryEvidence,
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
  webCrawlUrl?: string;
  recipients?: string[];
  preliminary?: boolean;
  executionToken?: string;
  mcp?: { connectionId: string; name: string; url: string; transport: McpTransport };
}

export interface PolicyContext {
  actor: string;
  agentId: string;
  runId?: string | null;
  /** Derived from the run origin; replay always suppresses external writes. */
  executionContext: ExecutionContext;
  runOrigin?: typeof runs.$inferSelect.origin;
  runChannel?: string;
  hasMemoryEvidence?: boolean;
  lifecycle: LifecycleState;
  enabledTools: string[];
  webCrawlScopes?: string[];
  approvalTools: string[];
  approvalSpendCents: number | null;
  approvalExpiresAfterHours: number | null;
  consentRequiredTools: ConsentScope[];
  budgets: ReturnType<typeof parseBudgets>;
  globalPaused: boolean;
  usage: BudgetSnapshot['day'] & { month: BudgetSnapshot['month']; activeRuns: number };
}

export interface PolicyResult {
  decision: PolicyDecision;
  reasons: string[];
  intentId: string;
  created?: boolean;
  payload?: Record<string, unknown>;
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
  options: { currentApproval?: boolean } = {},
): Promise<PolicyContext | null> {
  const agent = (await store.select().from(agents).where(eq(agents.id, agentId))).at(0);
  if (!agent) return null;
  const runRow = runId
    ? (
        await store
          .select({
            settings: configurations.approvalSettings,
            origin: runs.origin,
            channel: runs.channel,
          })
          .from(runs)
          .innerJoin(configurations, eq(configurations.id, runs.configurationId))
          .where(and(eq(runs.id, runId), eq(runs.agentId, agentId)))
      ).at(0)
    : undefined;
  const approval = options.currentApproval ? agent : (runRow?.settings ?? agent);
  const executionContext = executionContextForOrigin(runRow?.origin);
  const global = (await store.select().from(controls).where(eq(controls.id, 1))).at(0);
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const counters = await store
    .select()
    .from(usageCounters)
    .where(eq(usageCounters.agentId, agentId));
  const day = counters.find((row) => row.period === 'day' && row.periodStart === today);
  const month = counters.find((row) => row.period === 'month' && row.periodStart === monthStart);
  // Exclude the already-admitted run and cross-lane occupancy so in-run tool
  // authorization does not trip maxConcurrentRuns (defaults to 1) when an interactive
  // Playground run coexists with a background run.
  const activeRows = await store
    .select({ id: runs.id, origin: runs.origin, status: runs.status })
    .from(runs)
    .where(
      and(
        eq(runs.agentId, agentId),
        inArray(runs.status, ['queued', 'running', 'awaiting_approval']),
      ),
    );
  const activeRuns = countCompetingActiveRuns(
    activeRows,
    runId ? { id: runId, origin: runRow?.origin } : null,
  );

  return {
    actor,
    agentId,
    runId: runId ?? null,
    executionContext,
    runOrigin: runRow?.origin,
    runChannel: runRow && channelForRun(runRow)?.id,
    lifecycle: agent.lifecycle,
    enabledTools: Array.isArray(agent.enabledTools) ? agent.enabledTools : [],
    webCrawlScopes: agent.webCrawlScopes,
    approvalTools: mergeApprovalTools(approval.approvalTools, global?.approvalTools),
    approvalSpendCents: approval.approvalSpendCents,
    approvalExpiresAfterHours: approval.approvalExpiresAfterHours,
    consentRequiredTools: agent.consentRequiredTools,
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
  mcpGranted = false,
  options: { skipApproval?: boolean } = {},
): {
  decision: PolicyDecision;
  reasons: string[];
  violation?: BudgetViolation;
} {
  const reasons: string[] = [];

  if (ctx.lifecycle === 'stopped') {
    reasons.push('Agent is stopped; external writes are blocked.');
    return { decision: 'deny', reasons };
  }

  if (ctx.lifecycle === 'paused') {
    reasons.push('Agent is paused.');
    return { decision: 'deny', reasons };
  }

  if (peopleGrant.safeParse(action.type).success) {
    if (!ctx.runId || !ctx.runOrigin || !action.executionToken) {
      return { decision: 'deny', reasons: ['People tools require an owned run.'] };
    }
    if (!ctx.enabledTools.includes(action.type)) {
      return { decision: 'deny', reasons: [`Tool ${action.type} is not enabled for this agent.`] };
    }
    if (ctx.executionContext === 'replay') {
      return { decision: 'deny', reasons: ['Replay uses the saved case and its memory snapshot.'] };
    }
    if (action.type === PEOPLE_INTRODUCE && channelAdapter(ctx.runChannel)?.run.mode === 'draft') {
      return { decision: 'deny', reasons: ['Draft runs can read People profiles only.'] };
    }
    return { decision: 'allow', reasons: ['People tool permitted for this agent.'] };
  }

  if (isCommitmentTool(action.type)) {
    if (
      !ctx.runId ||
      !ctx.runChannel ||
      !action.executionToken ||
      ctx.runOrigin === 'playground' ||
      ctx.executionContext === 'replay'
    ) {
      return { decision: 'deny', reasons: ['Commitments require an owned channel run.'] };
    }
    if (!ctx.enabledTools.includes(action.type)) {
      return { decision: 'deny', reasons: ['This commitment tool is not enabled for the agent.'] };
    }
    return { decision: 'allow', reasons: ['The conversation commitment is permitted.'] };
  }

  // Internal memory operations are tied to a persisted, owned run. Capture does
  // not dispatch outbound actions or change any configuration or permissions.
  if (
    action.type === MEMORY_CAPTURE ||
    action.type === MEMORY_SEARCH ||
    action.type === HISTORY_SEARCH
  ) {
    if (!ctx.runId || !ctx.runOrigin || !action.executionToken) {
      return { decision: 'deny', reasons: ['Memory requires an owned run.'] };
    }
    if (
      action.type === MEMORY_CAPTURE &&
      (ctx.executionContext === 'replay' || !memoryCaptureOrigin(ctx.runOrigin))
    ) {
      return { decision: 'deny', reasons: ['This run can read memory only.'] };
    }
    if (action.type === MEMORY_CAPTURE && !ctx.hasMemoryEvidence) {
      return { decision: 'deny', reasons: ['Memory capture requires a persisted source.'] };
    }
    return { decision: 'allow', reasons: ['Agent memory operation permitted.'] };
  }

  if (
    action.type === 'introduce' &&
    action.executionToken &&
    ctx.executionContext !== 'replay' &&
    ctx.enabledTools.includes(PEOPLE_INTRODUCE)
  ) {
    return {
      decision: 'deny',
      reasons: ['Use the People introduction tool for proposal-specific consent.'],
    };
  }

  if (!action.readOnly && !canAcceptBackgroundWork(ctx.lifecycle)) {
    reasons.push(`Agent lifecycle ${ctx.lifecycle} does not accept this work.`);
    return { decision: 'deny', reasons };
  }

  const web = isWebTool(action.type);
  if (
    web &&
    (!action.readOnly ||
      !ctx.runId ||
      !ctx.runOrigin ||
      !action.executionToken ||
      ctx.executionContext === 'replay')
  ) {
    return { decision: 'deny', reasons: ['Web research requires an active authorised run.'] };
  }
  if (action.type === WEB_CRAWL && ctx.enabledTools.includes(WEB_CRAWL)) {
    const seed = publicPageUrl(action.webCrawlUrl ?? '');
    if (!seed || !crawlAllowed(seed, ctx.webCrawlScopes ?? [])) {
      return {
        decision: 'deny',
        reasons: ['The crawl URL is outside this agent’s approved scope.'],
      };
    }
  }
  const isMcp = action.type.startsWith('mcp:');
  const inRunTool = action.type === 'load_skill' || isMcp;
  const registered = channelAction(action.type);
  if (registered && ctx.executionContext !== 'replay' && registered.channel !== ctx.runChannel) {
    return { decision: 'deny', reasons: ['Action is unavailable for this run’s channel.'] };
  }
  if (
    registered &&
    !registered.action.usesProviderGrant &&
    !ctx.enabledTools.includes(action.type)
  ) {
    return { decision: 'deny', reasons: [`Tool ${action.type} is not enabled for this agent.`] };
  }
  // knowledge.search is opt-in and must not flip empty-list semantics for other native tools.
  const nativeEnablementTools = ctx.enabledTools.filter((tool) => {
    const channelGrant = channelAction(tool)?.action;
    return (
      !isWebTool(tool) &&
      tool !== KNOWLEDGE_SEARCH_TOOL &&
      !isCommitmentTool(tool) &&
      !peopleGrant.safeParse(tool).success &&
      (!channelGrant || channelGrant.usesProviderGrant)
    );
  });
  const toolDenied = isMcp
    ? !mcpGranted
    : action.type === 'load_skill'
      ? false
      : web || action.type === KNOWLEDGE_SEARCH_TOOL
        ? !ctx.enabledTools.includes(action.type)
        : (!registered || registered.action.usesProviderGrant) &&
          nativeEnablementTools.length > 0 &&
          !nativeEnablementTools.includes(action.type);
  if (toolDenied) {
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
    // Tools inside an already admitted run do not open another concurrency slot.
    activeRuns:
      ctx.runId && (web || action.type === KNOWLEDGE_SEARCH_TOOL || inRunTool)
        ? 0
        : ctx.usage.activeRuns,
  };

  if (!action.readOnly) {
    const outbound = checkOutboundBudgets(snapshot);
    if (outbound) {
      reasons.push(budgetViolationMessage(outbound));
      return { decision: 'deny', reasons, violation: outbound };
    }

    if (consentFailure) return { decision: 'deny', reasons: [consentFailure] };

    // Replay suppresses before approval so comparisons never suspend for review.
    if (ctx.executionContext === 'replay') {
      reasons.push('Replay execution suppresses all external writes.');
      return { decision: 'suppressed', reasons };
    }

    // Record approval proposals even while the global pause is on; pause still
    // blocks approve-time rechecks and dispatch (skipApproval path below).
    if (
      !options.skipApproval &&
      actionNeedsApproval({
        actionType: action.type,
        preliminary: action.preliminary,
        requiredByAdapter:
          registered?.action.alwaysRequiresApproval ||
          (ctx.lifecycle === 'shadow' && registered?.action.reviewInShadow),
        approvalTools: ctx.approvalTools,
        approvalSpendCents: ctx.approvalSpendCents,
        daySpendMicros: ctx.usage.spendMicros,
      })
    ) {
      return {
        decision: 'needs-approval',
        reasons: ['An administrator must review this proposal.'],
      };
    }

    if (ctx.globalPaused) {
      reasons.push('Global outbound pause is enabled.');
      return { decision: 'deny', reasons };
    }

    // Structural outbound gate — replay refuses; live needs a write adapter.
    const dispatch = authorizeOutboundDispatch({
      executionContext: ctx.executionContext,
      lifecycle: ctx.lifecycle,
      adapterAvailable: Boolean(registered),
    });
    if (!dispatch.allowed) {
      reasons.push(
        ctx.lifecycle === 'live'
          ? 'Live mode is active, but no external action adapter is configured for this action. Proposal suppressed.'
          : 'Shadow mode suppresses external writes. Proposal logged only.',
      );
      return { decision: 'suppressed', reasons };
    }
    reasons.push('Authorized for outbound dispatch.');
    return { decision: 'allow', reasons };
  }

  // load_skill and authorized MCP tools add neither inference requests nor spend —
  // the stage reservation already covers them (and may exactly fill the spend cap).
  const requestLimit = inRunTool
    ? checkRequestBudgets(snapshot, BigInt(0), 0, { checkSpend: false })
    : checkRequestBudgets(snapshot, BigInt(0), 1, { checkSpend: !web });
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
  store?: Tx,
): Promise<PolicyResult> {
  const authorize = async (tx: Tx): Promise<PolicyResult> => {
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
      const query = tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.id, ctx.runId),
            eq(runs.agentId, ctx.agentId),
            eq(runs.executionToken, action.executionToken),
            eq(runs.status, 'running'),
            sql`${runs.expiresAt} > now()`,
          ),
        );
      const storesInternalRecord =
        action.type === MEMORY_CAPTURE ||
        action.type === PEOPLE_INTRODUCE ||
        isCommitmentTool(action.type);
      const owned = (await (storesInternalRecord ? query.for('update') : query)).at(0);
      if (!owned) throw new BudgetError('cancelled');
      if (action.type === MEMORY_CAPTURE && memoryCaptureOrigin(current.runOrigin)) {
        const sources = await tx
          .select({ id: runMemoryEvidence.sourceId })
          .from(runMemoryEvidence)
          .where(
            and(eq(runMemoryEvidence.agentId, ctx.agentId), eq(runMemoryEvidence.runId, owned.id)),
          )
          .limit(2);
        current.hasMemoryEvidence = sources.length === 1;
      }
    }
    const recipients = action.recipients ?? [];
    const consentFailure =
      action.readOnly || action.type === MEMORY_CAPTURE || isCommitmentTool(action.type)
        ? null
        : await recipientConsentFailure(
            tx,
            current.agentId,
            action.type,
            recipients,
            current.consentRequiredTools,
          );
    const mcp = action.type.startsWith('mcp:') && action.readOnly ? action.mcp : undefined;
    const grant =
      mcp &&
      (
        await tx
          .select({
            name: mcpConnections.name,
            allowlist: mcpConnections.toolAllowlist,
            toolNames: agentMcpConnections.toolNames,
          })
          .from(agentMcpConnections)
          .innerJoin(mcpConnections, eq(mcpConnections.id, agentMcpConnections.connectionId))
          .where(
            and(
              eq(agentMcpConnections.agentId, ctx.agentId),
              eq(mcpConnections.id, mcp.connectionId),
              eq(mcpConnections.url, mcp.url),
              eq(mcpConnections.transport, mcp.transport),
            ),
          )
          .for('share', { of: mcpConnections })
      ).at(0);
    const mcpGranted = Boolean(
      mcp &&
      grant &&
      action.type === mcpToolId(grant.name, mcp.name) &&
      grant.toolNames.includes(mcp.name) &&
      mcpToolIsReadOnly(normalizeMcpAllowlist(grant.allowlist), mcp.name),
    );
    const evaluated = evaluateCandidate(current, action, consentFailure, mcpGranted);
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
        return {
          ...evaluated,
          intentId: existing.id,
          payload: existing.payload,
        };
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
        payload: existing.payload,
      };
    }

    // Firecrawl requests use the existing request counters. Crawl page usage is reserved
    // separately by the crawl admission transaction and OpenRouter spend is independent.
    if (isWebTool(action.type) && evaluated.decision === 'allow') {
      await recordRequestUsage(
        tx,
        ctx.agentId,
        new Date().toISOString().slice(0, 10),
        BigInt(0),
        1,
      );
    }

    const reviewExpiresAt =
      evaluated.decision === 'needs-approval' && current.approvalExpiresAfterHours
        ? new Date(Date.now() + current.approvalExpiresAfterHours * 60 * 60 * 1000)
        : null;
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
          reviewExpiresAt,
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

    if (evaluated.decision === 'needs-approval') {
      void notifyApprovalPending({
        intentId: intent.id,
        agentId: ctx.agentId,
        runId: ctx.runId ?? null,
        actionType: action.type,
        reason: evaluated.reasons[0] ?? 'Approval required',
        createdAt: intent.createdAt,
      });
    }

    return {
      decision: evaluated.decision,
      reasons: evaluated.reasons,
      intentId: intent.id,
      created: true,
      payload: intent.payload,
      violation: evaluated.violation,
    };
  };
  return store ? authorize(store) : db().transaction(authorize);
}

/** Record a dispatch blocked after authorization, such as a concurrent budget reservation. */
export async function recordBlockedDispatch(
  ctx: PolicyContext,
  actionType: string,
  intentId: string,
  error: BudgetError,
): Promise<PolicyResult> {
  const decision = 'deny';
  const reasons = [error.message];
  await db()
    .insert(policyDecisions)
    .values({
      agentId: ctx.agentId,
      runId: ctx.runId ?? null,
      actionType,
      decision,
      reasons,
      intentId,
      actor: ctx.actor,
    });
  return {
    decision,
    reasons,
    intentId,
    violation: error.kind === 'cancelled' ? undefined : error.kind,
  };
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
    /** When set with token, reservation is scoped to an owned running simulation. */
    runId?: string;
    token?: string;
    signal?: AbortSignal;
    /** When set, reservation is idempotent per run+stage across queue retries. */
    stage?: 'evaluator' | 'main';
    requiredTool?: string;
    /**
     * Provider calls covered by this reservation (tool loops may issue several).
     * Defaults to 1. Request counters and request-cap checks use this value.
     */
    providerCalls?: number;
  },
) {
  const requestedMicros = BigInt(upperBoundMicros ?? 0);
  const providerCalls = Math.max(1, execution?.providerCalls ?? 1);
  const outcome = await retryableStore(() =>
    db().transaction(async (tx) => {
      const agent = (await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')).at(
        0,
      );
      if (!agent || agent.lifecycle === 'stopped' || execution?.signal?.aborted) {
        throw new BudgetError('cancelled');
      }
      if (
        execution?.requiredTool &&
        (agent.lifecycle === 'paused' || !agent.enabledTools.includes(execution.requiredTool))
      ) {
        throw new BudgetError('cancelled');
      }
      let runRow:
        | {
            id: string;
            result: (typeof runs)['$inferSelect']['result'];
          }
        | undefined;
      if (execution?.runId && execution.token) {
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
          let reservedRequests = existing.reservedRequests ?? 1;
          let reservation = existing;
          const additionalSpend =
            requestedMicros > reservedMicros ? requestedMicros - reservedMicros : BigInt(0);
          const additionalRequests =
            providerCalls > reservedRequests ? providerCalls - reservedRequests : 0;
          if (additionalSpend > BigInt(0) || additionalRequests > 0) {
            // Top up spend and/or request slots against the original accounting period.
            // Request slots can grow when a retry attaches tools (e.g. skill load_skill).
            for (const [reached, reservationKind, used, cap] of [
              [
                'daily-spend',
                'daily-spend-reservation',
                reservationDay.spendMicros,
                budgets.dailySpendCents,
              ],
              [
                'monthly-spend',
                'monthly-spend-reservation',
                reservationMonth.spendMicros,
                budgets.monthlySpendCents,
              ],
            ] as const) {
              if (cap === null || additionalSpend === BigInt(0)) continue;
              const limit = BigInt(cap) * BigInt(10_000);
              if (used >= limit) throw new BudgetError(reached);
              if (used + additionalSpend > limit) throw new BudgetError(reservationKind);
            }
            if (additionalRequests > 0) {
              if (reservationDay.requests + additionalRequests > budgets.dailyRequests) {
                throw new BudgetError('daily-requests');
              }
              if (reservationMonth.requests + additionalRequests > budgets.monthlyRequests) {
                throw new BudgetError('monthly-requests');
              }
            }
            await recordRequestUsage(tx, agentId, periodStart, additionalSpend, additionalRequests);
            reservedMicros = requestedMicros > reservedMicros ? requestedMicros : reservedMicros;
            reservedRequests = Math.max(reservedRequests, providerCalls);
            reservation = {
              stage: execution.stage,
              reservedMicros: reservedMicros.toString(),
              reservedRequests,
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
          }
          return {
            today: periodStart,
            reservedMicros,
            reservedRequests,
            reservation,
            reused: true as const,
          };
        }
      }

      const violation = checkRequestBudgets(
        { budgets, day, month, activeRuns: 0 },
        requestedMicros,
        providerCalls,
      );
      if (violation) throw new BudgetError(violation);
      await recordRequestUsage(tx, agentId, today, requestedMicros, providerCalls);
      const reservation =
        execution?.stage !== undefined
          ? {
              stage: execution.stage,
              reservedMicros: requestedMicros.toString(),
              reservedRequests: providerCalls,
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
        reservedRequests: providerCalls,
        reservation,
        reused: false as const,
      };
    }),
  );

  // Keep the full reservation after ambiguous failures or missing costs. Settlement is attempted
  // once per dispatch, so a connection loss during commit cannot double-apply the adjustment.
  return Object.assign(
    async (billedMicros: number, actualProviderCalls?: number) => {
      const spendAdjustment = BigInt(billedMicros) - outcome.reservedMicros;
      // Release unused request slots once the generation-step count is known.
      const requestAdjustment =
        actualProviderCalls === undefined
          ? 0
          : Math.max(1, actualProviderCalls) - outcome.reservedRequests;
      if (spendAdjustment !== BigInt(0) || requestAdjustment !== 0) {
        await db().transaction((tx) =>
          recordRequestUsage(tx, agentId, outcome.today, spendAdjustment, requestAdjustment),
        );
      }
    },
    {
      reservation: outcome.reservation,
      reused: outcome.reused,
      reservedMicros: outcome.reservedMicros,
    },
  );
}

/** Pure evaluation helper for unit tests without persistence. */
export function evaluateActionForTest(
  ctx: Omit<
    PolicyContext,
    | 'actor'
    | 'agentId'
    | 'runId'
    | 'usage'
    | 'approvalTools'
    | 'approvalSpendCents'
    | 'approvalExpiresAfterHours'
    | 'consentRequiredTools'
    | 'executionContext'
  > & {
    usage?: PolicyContext['usage'];
    approvalTools?: string[];
    approvalSpendCents?: number | null;
    approvalExpiresAfterHours?: number | null;
    consentRequiredTools?: ConsentScope[];
    executionContext?: ExecutionContext;
  },
  action: CandidateAction,
  options?: { skipApproval?: boolean; consentFailure?: string | null },
) {
  return evaluateCandidate(
    {
      actor: 'test',
      agentId: '00000000-0000-0000-0000-000000000000',
      runId: null,
      executionContext: ctx.executionContext ?? 'standard',
      approvalTools: ctx.approvalTools ?? [],
      approvalSpendCents: ctx.approvalSpendCents ?? null,
      approvalExpiresAfterHours: ctx.approvalExpiresAfterHours ?? null,
      consentRequiredTools: ctx.consentRequiredTools ?? [],
      usage: ctx.usage ?? {
        ...emptyUsage(),
        month: emptyUsage(),
        activeRuns: 0,
      },
      ...ctx,
    },
    action,
    options?.consentFailure ?? null,
    false,
    options,
  );
}
