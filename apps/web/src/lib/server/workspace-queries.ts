import 'server-only';

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { budgetViolationMessage, parseBudgets } from '@/lib/budgets';
import { db } from '@/lib/db';
import { ACTIVE_CRAWL_STATES } from '@/lib/research';
import { channelForRun } from '@/lib/runtime/channels/registry';
import { openRouterKeySource } from '@/lib/runtime/openrouter-key';
import { latestPersistedRun } from '@/lib/runtime/playground-ui';
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
  introductionProposals,
  jobs,
  personIdentities,
  recipientConsents,
  runMemoryEvidence,
  runs,
  templates,
  usageCounters,
  webCrawls,
} from '@/lib/schema';

async function countPendingApprovals() {
  const [pending] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(actionIntents)
    .where(eq(actionIntents.reviewStatus, 'pending'));
  return pending.count;
}

export async function getPendingApprovalCount() {
  await requireAdmin();
  return countPendingApprovals();
}

export async function listAgentOptions() {
  await requireAdmin();
  return db().select({ id: agents.id, name: agents.name }).from(agents).orderBy(asc(agents.name));
}

export async function getOverview() {
  const email = await requireAdmin();
  return { email, pendingApprovalCount: countPendingApprovals(), data: loadOverviewData() };
}

async function loadOverviewData() {
  const [team, events, state, presets] = await Promise.all([
    db().select().from(agents).orderBy(desc(agents.createdAt)),
    db().select().from(audit).orderBy(desc(audit.createdAt)).limit(12),
    db().select().from(controls),
    db().select().from(templates),
  ]);
  return {
    team,
    events,
    state,
    presets,
  };
}

export async function getApprovalsInbox(filterAgentId?: string, filterRunId?: string) {
  await requireAdmin();
  const agentFilter = filterAgentId ? eq(actionIntents.agentId, filterAgentId) : undefined;
  const runFilter = filterRunId
    ? or(eq(actionIntents.runId, filterRunId), eq(introductionProposals.runId, filterRunId))
    : undefined;
  const [team, items, pending, pendingTotal, controlRows] = await Promise.all([
    db()
      .select({ id: agents.id, name: agents.name, lifecycle: agents.lifecycle })
      .from(agents)
      .orderBy(asc(agents.name)),
    db()
      .select({
        id: actionIntents.id,
        agentId: actionIntents.agentId,
        agentName: agents.name,
        agentLifecycle: agents.lifecycle,
        runId: sql<string | null>`coalesce(${actionIntents.runId}, ${introductionProposals.runId})`,
        introductionId: introductionProposals.id,
        actionType: actionIntents.actionType,
        draft: sql<string | null>`${actionIntents.payload}->>'draft'`,
        subject: sql<string | null>`${actionIntents.payload}->>'subject'`,
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
      .leftJoin(introductionProposals, eq(introductionProposals.reviewIntentId, actionIntents.id))
      .where(and(isNotNull(actionIntents.reviewStatus), agentFilter, runFilter))
      .orderBy(sql`(${actionIntents.reviewStatus} = 'pending') DESC`, desc(actionIntents.createdAt))
      .limit(100),
    db()
      .select({ count: sql<number>`count(*)::int` })
      .from(actionIntents)
      .leftJoin(introductionProposals, eq(introductionProposals.reviewIntentId, actionIntents.id))
      .where(and(eq(actionIntents.reviewStatus, 'pending'), agentFilter, runFilter)),
    countPendingApprovals(),
    db().select({ paused: controls.paused }).from(controls).where(eq(controls.id, 1)).limit(1),
  ]);
  const agentStates = Object.fromEntries(team.map((agent) => [agent.id, agent.lifecycle]));
  return {
    team: team.map(({ id, name }) => ({ id, name })),
    items,
    pendingCount: pending[0]?.count ?? 0,
    totalPendingCount: pendingTotal,
    globalPaused: controlRows[0]?.paused ?? true,
    agentStates,
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
  const activeCrawl = inArray(webCrawls.status, ACTIVE_CRAWL_STATES);
  // Keep a newly finished crawl visible long enough for an operator to inspect its outcome.
  const recentCrawl = db()
    .select({ runId: webCrawls.runId })
    .from(webCrawls)
    .where(
      and(
        eq(webCrawls.agentId, id),
        or(activeCrawl, gt(webCrawls.finishedAt, sql`now() - interval '10 minutes'`)),
      ),
    )
    .orderBy(desc(activeCrawl), desc(webCrawls.finishedAt))
    .limit(1);
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
    controlRows,
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
      .select({
        run: runs,
        personId: personIdentities.personId,
        sourceTitle: runMemoryEvidence.title,
        sourceHref: runMemoryEvidence.href,
        sourceLinkLabel: runMemoryEvidence.linkLabel,
        authorHandle: runMemoryEvidence.author,
      })
      .from(runs)
      .leftJoin(
        runMemoryEvidence,
        and(eq(runMemoryEvidence.runId, runs.id), eq(runMemoryEvidence.agentId, runs.agentId)),
      )
      .leftJoin(personIdentities, eq(personIdentities.id, runMemoryEvidence.personIdentityId))
      .where(and(eq(runs.agentId, id), ne(runs.origin, 'replay')))
      .orderBy(
        ...(focusRunId ? [desc(sql`${runs.id} = ${focusRunId}::uuid`)] : []),
        desc(sql`coalesce(${runs.id} = (${recentCrawl}), false)`),
        desc(runs.createdAt),
      )
      .limit(50),
    db()
      .select({
        id: actionIntents.id,
        actionType: actionIntents.actionType,
        draft: sql<string | null>`${actionIntents.payload}->>'draft'`,
        subject: sql<string | null>`${actionIntents.payload}->>'subject'`,
        reason: sql<string | null>`${actionIntents.payload}->>'reason'`,
        recipients: actionIntents.recipients,
        status: actionIntents.reviewStatus,
        createdAt: actionIntents.createdAt,
        reviewedBy: actionIntents.reviewedBy,
        introductionId: introductionProposals.id,
      })
      .from(actionIntents)
      .leftJoin(introductionProposals, eq(introductionProposals.reviewIntentId, actionIntents.id))
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
      .where(and(eq(recipientConsents.agentId, id), isNull(recipientConsents.introductionId)))
      .orderBy(desc(recipientConsents.updatedAt))
      .limit(50),
    db().select().from(usageCounters).where(eq(usageCounters.agentId, id)),
    countPendingApprovals(),
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
    db().select({ paused: controls.paused }).from(controls).where(eq(controls.id, 1)).limit(1),
  ]);
  const current = versions.at(0);
  if (!current) return null;
  const jobIds = history.map(({ run }) => run.jobId).filter((jobId): jobId is string => !!jobId);
  const linkedJobs = jobIds.length
    ? await db().select().from(jobs).where(inArray(jobs.id, jobIds))
    : [];
  const jobsById = new Map(linkedJobs.map((job) => [job.id, job]));
  const describeRun = ({
    run,
    personId,
    sourceTitle,
    sourceHref,
    sourceLinkLabel,
    authorHandle,
  }: (typeof history)[number]) => {
    // awaiting_approval waits on reviewExpiresAt, not the execution deadline.
    const expired = isExpiredSimulationRun(run);
    const deferred = Boolean(run.deferReason) && (run.status === 'failed' || expired);
    return {
      ...run,
      personId,
      sourceTitle: sourceTitle || run.input,
      authorHandle,
      sourceHref: sourceHref?.endsWith(`#run-${run.id}`) ? null : sourceHref,
      sourceLinkLabel,
      channelName: channelForRun(run)?.label ?? run.channel ?? 'Playground',
      preferDraftAnswer: channelForRun(run)?.run.mode === 'draft',
      deferReason: run.deferReason ?? (expired ? budgetViolationMessage('run-deadline') : null),
      interrupted: expired || run.status === 'interrupted',
      displayStatus: expired
        ? ('interrupted' as const)
        : deferred
          ? ('deferred' as const)
          : run.status,
      job: run.jobId ? (jobsById.get(run.jobId) ?? null) : null,
    };
  };
  const viewedHistory = history.map(describeRun);
  const latestPlaygroundRun = latestPersistedRun(
    viewedHistory.filter((run) => run.origin === 'playground'),
  );
  const olderPlaygroundRun =
    !latestPlaygroundRun && history.length === 50
      ? (
          await db()
            .select()
            .from(runs)
            .where(and(eq(runs.agentId, id), eq(runs.origin, 'playground')))
            .orderBy(desc(runs.createdAt))
            .limit(1)
        ).at(0)
      : undefined;
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
    latestPlaygroundRun:
      latestPlaygroundRun ??
      (olderPlaygroundRun
        ? describeRun({
            run: olderPlaygroundRun,
            personId: null,
            sourceTitle: null,
            sourceHref: null,
            sourceLinkLabel: null,
            authorHandle: null,
          })
        : undefined),
    reviews,
    pendingApprovalCount: pendingApprovals,
    globalPaused: controlRows[0]?.paused ?? true,
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
