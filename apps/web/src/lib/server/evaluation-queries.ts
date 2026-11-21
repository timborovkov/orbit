import 'server-only';

import { and, desc, eq } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { channelAdapter, channelLabel } from '@/lib/runtime/channels/registry';
import { agents, configurations, evaluationCases, evaluationComparisons, runs } from '@/lib/schema';

export async function listEvaluationWorkspace(agentId?: string) {
  await requireAdmin();
  const database = db();

  const caseFilter = agentId ? and(eq(evaluationCases.agentId, agentId)) : undefined;
  const comparisonFilter = agentId ? and(eq(evaluationComparisons.agentId, agentId)) : undefined;

  const [agentRows, cases, comparisons, versionRows] = await Promise.all([
    database.select({ id: agents.id, name: agents.name }).from(agents).orderBy(agents.name),
    database
      .select({
        id: evaluationCases.id,
        agentId: evaluationCases.agentId,
        title: evaluationCases.title,
        sourceKind: evaluationCases.sourceKind,
        sourceChannel: evaluationCases.sourceChannel,
        input: evaluationCases.input,
        recipients: evaluationCases.recipients,
        createdAt: evaluationCases.createdAt,
        agentName: agents.name,
      })
      .from(evaluationCases)
      .innerJoin(agents, eq(agents.id, evaluationCases.agentId))
      .where(caseFilter)
      .orderBy(desc(evaluationCases.createdAt))
      .limit(100),
    database
      .select({
        id: evaluationComparisons.id,
        agentId: evaluationComparisons.agentId,
        caseId: evaluationComparisons.caseId,
        status: evaluationComparisons.status,
        createdAt: evaluationComparisons.createdAt,
        finishedAt: evaluationComparisons.finishedAt,
        error: evaluationComparisons.error,
        leftConfigurationId: evaluationComparisons.leftConfigurationId,
        rightConfigurationId: evaluationComparisons.rightConfigurationId,
        leftRunId: evaluationComparisons.leftRunId,
        rightRunId: evaluationComparisons.rightRunId,
        agentName: agents.name,
        caseTitle: evaluationCases.title,
        caseInput: evaluationCases.input,
      })
      .from(evaluationComparisons)
      .innerJoin(agents, eq(agents.id, evaluationComparisons.agentId))
      .innerJoin(evaluationCases, eq(evaluationCases.id, evaluationComparisons.caseId))
      .where(comparisonFilter)
      .orderBy(desc(evaluationComparisons.createdAt))
      .limit(100),
    database
      .select({
        id: configurations.id,
        agentId: configurations.agentId,
        version: configurations.version,
        config: configurations.config,
      })
      .from(configurations)
      .orderBy(desc(configurations.version)),
  ]);

  return {
    agents: agentRows,
    cases: cases.map((row) => {
      const id = row.sourceChannel ?? channelAdapter(row.sourceKind)?.id;
      return { ...row, sourceLabel: id ? channelLabel(id) : 'Playground' };
    }),
    comparisons,
    versions: versionRows.map((row) => ({
      id: row.id,
      agentId: row.agentId,
      version: row.version,
      name: row.config.name || '',
    })),
  };
}

export async function getEvaluationComparison(comparisonId: string) {
  await requireAdmin();
  const database = db();

  const comparison = (
    await database
      .select({
        id: evaluationComparisons.id,
        agentId: evaluationComparisons.agentId,
        caseId: evaluationComparisons.caseId,
        status: evaluationComparisons.status,
        createdAt: evaluationComparisons.createdAt,
        finishedAt: evaluationComparisons.finishedAt,
        error: evaluationComparisons.error,
        leftConfigurationId: evaluationComparisons.leftConfigurationId,
        rightConfigurationId: evaluationComparisons.rightConfigurationId,
        leftRunId: evaluationComparisons.leftRunId,
        rightRunId: evaluationComparisons.rightRunId,
        agentName: agents.name,
        caseTitle: evaluationCases.title,
        caseInput: evaluationCases.input,
        caseRecipients: evaluationCases.recipients,
        caseSourceChannel: evaluationCases.sourceChannel,
        caseSourceKind: evaluationCases.sourceKind,
      })
      .from(evaluationComparisons)
      .innerJoin(agents, eq(agents.id, evaluationComparisons.agentId))
      .innerJoin(evaluationCases, eq(evaluationCases.id, evaluationComparisons.caseId))
      .where(eq(evaluationComparisons.id, comparisonId))
  ).at(0);

  if (!comparison) return null;

  const versionRows = await database
    .select({
      id: configurations.id,
      version: configurations.version,
      config: configurations.config,
    })
    .from(configurations)
    .where(eq(configurations.agentId, comparison.agentId));

  const versionFor = (id: string) => versionRows.find((row) => row.id === id);

  const loadRun = async (runId: string | null) => {
    if (!runId) return null;
    return (await database.select().from(runs).where(eq(runs.id, runId))).at(0) ?? null;
  };

  const [leftRun, rightRun] = await Promise.all([
    loadRun(comparison.leftRunId),
    loadRun(comparison.rightRunId),
  ]);

  const leftVersion = versionFor(comparison.leftConfigurationId);
  const rightVersion = versionFor(comparison.rightConfigurationId);
  const channelId = comparison.caseSourceChannel ?? channelAdapter(comparison.caseSourceKind)?.id;

  return {
    comparison,
    sourceLabel: channelId ? channelLabel(channelId) : 'Playground',
    preferDraftAnswer: channelAdapter(channelId)?.run.mode === 'draft',
    left: {
      configurationId: comparison.leftConfigurationId,
      version: leftVersion?.version ?? null,
      configName: leftVersion?.config.name ?? '',
      run: leftRun,
    },
    right: {
      configurationId: comparison.rightConfigurationId,
      version: rightVersion?.version ?? null,
      configName: rightVersion?.config.name ?? '',
      run: rightRun,
    },
  };
}
