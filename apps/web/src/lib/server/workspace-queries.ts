import 'server-only';

import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { budgetViolationMessage, parseBudgets } from '@/lib/budgets';
import { db } from '@/lib/db';
import { openRouterKeySource } from '@/lib/runtime/openrouter-key';
import { isExpiredSimulationRun } from '@/lib/runtime/simulation-watch';
import {
  actionIntents,
  agentMcpConnections,
  agents,
  agentSkills,
  audit,
  configurations,
  controls,
  credentials,
  jobs,
  recipientConsents,
  runs,
  templates,
  usageCounters,
} from '@/lib/schema';

export async function getOverview() {
  const email = await requireAdmin();
  const [team, events, state, presets, pendingApprovals] = await Promise.all([
    db().select().from(agents).orderBy(desc(agents.createdAt)),
    db().select().from(audit).orderBy(desc(audit.createdAt)).limit(12),
    db().select().from(controls),
    db().select().from(templates),
    db()
      .select({ count: sql<number>`count(*)::int` })
      .from(actionIntents)
      .where(eq(actionIntents.reviewStatus, 'pending')),
  ]);
  return {
    email,
    team,
    events,
    state,
    presets,
    pendingApprovalCount: pendingApprovals[0]?.count ?? 0,
  };
}

export async function getApprovalsInbox(filterAgentId?: string, filterRunId?: string) {
  await requireAdmin();
  const agentFilter = filterAgentId ? eq(actionIntents.agentId, filterAgentId) : undefined;
  const runFilter = filterRunId ? eq(actionIntents.runId, filterRunId) : undefined;
  const [team, items, pending, pendingTotal] = await Promise.all([
    db().select({ id: agents.id, name: agents.name }).from(agents).orderBy(asc(agents.name)),
    db()
      .select({
        id: actionIntents.id,
        agentId: actionIntents.agentId,
        agentName: agents.name,
        runId: actionIntents.runId,
        actionType: actionIntents.actionType,
        draft: sql<string | null>`${actionIntents.payload}->>'draft'`,
        reason: sql<string | null>`${actionIntents.payload}->>'reason'`,
        recipients: actionIntents.recipients,
        status: actionIntents.reviewStatus,
        createdAt: actionIntents.createdAt,
        reviewedBy: actionIntents.reviewedBy,
        reviewedAt: actionIntents.reviewedAt,
        reviewExpiresAt: actionIntents.reviewExpiresAt,
        reviewNote: actionIntents.reviewNote,
      })
      .from(actionIntents)
      .innerJoin(agents, eq(agents.id, actionIntents.agentId))
      .where(and(isNotNull(actionIntents.reviewStatus), agentFilter, runFilter))
      .orderBy(sql`(${actionIntents.reviewStatus} = 'pending') DESC`, desc(actionIntents.createdAt))
      .limit(100),
    db()
      .select({ count: sql<number>`count(*)::int` })
      .from(actionIntents)
      .where(and(eq(actionIntents.reviewStatus, 'pending'), agentFilter, runFilter)),
    db()
      .select({ count: sql<number>`count(*)::int` })
      .from(actionIntents)
      .where(eq(actionIntents.reviewStatus, 'pending')),
  ]);
  return {
    team,
    items,
    pendingCount: pending[0]?.count ?? 0,
    totalPendingCount: pendingTotal[0]?.count ?? 0,
  };
}

export async function getTemplates() {
  const email = await requireAdmin();
  const items = await db().select().from(templates).orderBy(asc(templates.title));
  return { email, items };
}
export async function getAgentPictureKey(id: string) {
  await requireAdmin();
  return (
    (await db().select({ key: agents.pictureKey }).from(agents).where(eq(agents.id, id))).at(0)
      ?.key ?? null
  );
}
export async function getAgentWorkspace(id: string, focusRunId?: string) {
  await requireAdmin();
  const agent = (await db().select().from(agents).where(eq(agents.id, id))).at(0);
  if (!agent) return null;
  const [
    versions,
    keys,
    history,
    reviews,
    consents,
    counters,
    pendingApprovals,
    activeRuns,
    skillRows,
    mcpRows,
  ] = await Promise.all([
    db()
      .select()
      .from(configurations)
      .where(eq(configurations.agentId, id))
      .orderBy(desc(configurations.version)),
    db()
      .select({ agentId: credentials.agentId })
      .from(credentials)
      .where(eq(credentials.agentId, id)),
    db()
      .select()
      .from(runs)
      .where(eq(runs.agentId, id))
      .orderBy(
        ...(focusRunId ? [desc(sql`${runs.id} = ${focusRunId}::uuid`)] : []),
        desc(runs.createdAt),
      )
      .limit(50),
    db()
      .select({
        id: actionIntents.id,
        actionType: actionIntents.actionType,
        draft: sql<string | null>`${actionIntents.payload}->>'draft'`,
        reason: sql<string | null>`${actionIntents.payload}->>'reason'`,
        recipients: actionIntents.recipients,
        status: actionIntents.reviewStatus,
        createdAt: actionIntents.createdAt,
        reviewedBy: actionIntents.reviewedBy,
      })
      .from(actionIntents)
      .where(and(eq(actionIntents.agentId, id), isNotNull(actionIntents.reviewStatus)))
      .orderBy(sql`(${actionIntents.reviewStatus} = 'pending') DESC`, desc(actionIntents.createdAt))
      .limit(50),
    db()
      .select({
        recipient: recipientConsents.recipient,
        scope: recipientConsents.scope,
        evidence: recipientConsents.evidence,
        granted: recipientConsents.granted,
      })
      .from(recipientConsents)
      .where(eq(recipientConsents.agentId, id))
      .orderBy(desc(recipientConsents.updatedAt))
      .limit(50),
    db().select().from(usageCounters).where(eq(usageCounters.agentId, id)),
    db()
      .select({ count: sql<number>`count(*)::int` })
      .from(actionIntents)
      .where(eq(actionIntents.reviewStatus, 'pending')),
    db()
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .where(
        and(eq(runs.agentId, id), inArray(runs.status, ['queued', 'running', 'awaiting_approval'])),
      ),
    db()
      .select({ skillId: agentSkills.skillId })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, id)),
    db()
      .select({
        connectionId: agentMcpConnections.connectionId,
        toolNames: agentMcpConnections.toolNames,
      })
      .from(agentMcpConnections)
      .where(eq(agentMcpConnections.agentId, id)),
  ]);
  const current = versions.at(0);
  if (!current) return null;
  const jobIds = history.map((run) => run.jobId).filter((jobId): jobId is string => !!jobId);
  const linkedJobs = jobIds.length
    ? await db().select().from(jobs).where(inArray(jobs.id, jobIds))
    : [];
  const jobsById = new Map(linkedJobs.map((job) => [job.id, job]));
  const viewedHistory = history.map((run) => {
    // awaiting_approval waits on reviewExpiresAt, not the execution deadline.
    const expired = isExpiredSimulationRun(run);
    const deferred = Boolean(run.deferReason) && (run.status === 'failed' || expired);
    return {
      ...run,
      deferReason: run.deferReason ?? (expired ? budgetViolationMessage('run-deadline') : null),
      interrupted: expired || run.status === 'interrupted',
      displayStatus: expired
        ? ('interrupted' as const)
        : deferred
          ? ('deferred' as const)
          : run.status,
      job: run.jobId ? (jobsById.get(run.jobId) ?? null) : null,
    };
  });
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const emptyUsage = { spendMicros: BigInt(0), requests: 0, outboundActions: 0 };
  const day =
    counters.find((row) => row.period === 'day' && row.periodStart === today) ?? emptyUsage;
  const month =
    counters.find((row) => row.period === 'month' && row.periodStart === monthStart) ?? emptyUsage;
  const hasAgentCredential = keys.length > 0;
  return {
    agent: { ...agent, budgets: parseBudgets(agent.budgets) },
    versions,
    hasAgentCredential,
    keySource: openRouterKeySource(hasAgentCredential),
    history: viewedHistory,
    reviews,
    pendingApprovalCount: pendingApprovals[0]?.count ?? 0,
    consents,
    current,
    skillIds: skillRows.map((row) => row.skillId),
    mcpSelections: mcpRows,
    usage: {
      day: {
        spendMicros: day.spendMicros,
        requests: day.requests,
        outboundActions: day.outboundActions,
      },
      month: {
        spendMicros: month.spendMicros,
        requests: month.requests,
        outboundActions: month.outboundActions,
      },
      activeRuns: activeRuns[0]?.count ?? 0,
    },
  };
}
