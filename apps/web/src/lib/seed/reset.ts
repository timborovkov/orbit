import { inArray, or, sql } from 'drizzle-orm';

import {
  actionIntents,
  agentMcpConnections,
  agents,
  agentSkills,
  audit,
  configurations,
  credentials,
  discoveryCursors,
  emailMailboxes,
  emailMessages,
  emailThreads,
  jobs,
  knowledgeChunks,
  knowledgeDocuments,
  mcpConnections,
  outboundActions,
  policyDecisions,
  recipientConsents,
  runs,
  skills,
  sourceEvents,
  usageCounters,
} from '@/lib/schema';
import {
  DEMO_ACTOR,
  DEMO_AGENT_IDS,
  DEMO_AUDIT,
  DEMO_DISCOVERY_RUN_IDS,
  DEMO_EMAIL,
  DEMO_INTENTS,
  DEMO_JOBS,
  DEMO_KNOWLEDGE_CHUNK_IDS,
  DEMO_KNOWLEDGE_DOC_IDS,
  DEMO_POLICY,
  DEMO_RUNS,
  DEMO_SOURCE_EVENT_IDS,
} from '@/lib/seed/ids';
import type { SeedContext } from '@/lib/seed/types';

const demoJobIds = Object.values(DEMO_JOBS);
const demoRunIds = Object.values(DEMO_RUNS);
const demoIntentIds = Object.values(DEMO_INTENTS);
const demoPolicyIds = Object.values(DEMO_POLICY);
const demoAuditIds = Object.values(DEMO_AUDIT);
const demoAgentIds = [...DEMO_AGENT_IDS];
const demoKnowledgeDocIds = [...DEMO_KNOWLEDGE_DOC_IDS];

/**
 * Whether a job row belongs to the demo seed. Matches fixed demo job IDs,
 * `orbit-demo:` keys, and runtime jobs whose payload references a demo run,
 * agent, or knowledge document (e.g. `simulation:<runId>:resume:…`).
 */
export function isDemoOwnedJob(job: {
  id: string;
  idempotencyKey: string | null;
  payload: Record<string, unknown>;
}): boolean {
  if ((demoJobIds as readonly string[]).includes(job.id)) return true;
  if (job.idempotencyKey?.startsWith('orbit-demo:')) return true;
  const runId = typeof job.payload.runId === 'string' ? job.payload.runId : null;
  const agentId = typeof job.payload.agentId === 'string' ? job.payload.agentId : null;
  const documentId = typeof job.payload.documentId === 'string' ? job.payload.documentId : null;
  if (runId && (demoRunIds as readonly string[]).includes(runId)) return true;
  if (agentId && (demoAgentIds as readonly string[]).includes(agentId)) return true;
  if (documentId && (demoKnowledgeDocIds as readonly string[]).includes(documentId)) return true;
  return false;
}

function sqlTextInList(column: ReturnType<typeof sql>, values: readonly string[]) {
  return sql`${column} IN (${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}

/**
 * Delete only demo-owned rows (fixed IDs / DEMO_ACTOR). Never touches other agents.
 */
export async function resetDemoData(ctx: SeedContext): Promise<void> {
  const { tx } = ctx;

  await tx.delete(outboundActions).where(inArray(outboundActions.agentId, demoAgentIds));
  await tx.delete(outboundActions).where(inArray(outboundActions.id, [DEMO_EMAIL.outboundId]));

  await tx.delete(policyDecisions).where(inArray(policyDecisions.id, demoPolicyIds));
  await tx.delete(policyDecisions).where(inArray(policyDecisions.id, [DEMO_EMAIL.policyId]));
  await tx.delete(policyDecisions).where(inArray(policyDecisions.agentId, demoAgentIds));

  await tx.delete(actionIntents).where(inArray(actionIntents.id, demoIntentIds));
  await tx.delete(actionIntents).where(inArray(actionIntents.id, [DEMO_EMAIL.intentId]));
  await tx.delete(actionIntents).where(inArray(actionIntents.agentId, demoAgentIds));

  await tx.delete(sourceEvents).where(inArray(sourceEvents.id, [...DEMO_SOURCE_EVENT_IDS]));
  await tx.delete(sourceEvents).where(inArray(sourceEvents.agentId, demoAgentIds));
  await tx.delete(discoveryCursors).where(inArray(discoveryCursors.agentId, demoAgentIds));

  await tx.delete(emailMessages).where(inArray(emailMessages.agentId, demoAgentIds));
  await tx.delete(emailThreads).where(inArray(emailThreads.agentId, demoAgentIds));
  await tx.delete(emailMailboxes).where(inArray(emailMailboxes.agentId, demoAgentIds));

  // Clear run → job FK before deleting jobs.
  const discoveryRunIds = [...DEMO_DISCOVERY_RUN_IDS];
  await tx.update(runs).set({ jobId: null }).where(inArray(runs.id, demoRunIds));
  await tx.update(runs).set({ jobId: null }).where(inArray(runs.id, discoveryRunIds));
  await tx
    .update(runs)
    .set({ jobId: null })
    .where(inArray(runs.id, [DEMO_EMAIL.runId]));
  await tx.delete(runs).where(inArray(runs.id, demoRunIds));
  await tx.delete(runs).where(inArray(runs.id, discoveryRunIds));
  await tx.delete(runs).where(inArray(runs.id, [DEMO_EMAIL.runId]));
  await tx.delete(runs).where(inArray(runs.agentId, demoAgentIds));

  // Fixed seed jobs, orbit-demo keys, and runtime jobs for demo runs/agents
  // (resume keys use `simulation:…`, not `orbit-demo:`).
  await tx
    .delete(jobs)
    .where(
      or(
        inArray(jobs.id, demoJobIds),
        sql`${jobs.idempotencyKey} LIKE ${'orbit-demo:%'}`,
        sqlTextInList(sql`${jobs.payload}->>'runId'`, demoRunIds),
        sqlTextInList(sql`${jobs.payload}->>'agentId'`, demoAgentIds),
        sqlTextInList(sql`${jobs.payload}->>'documentId'`, demoKnowledgeDocIds),
      ),
    );
  await tx
    .delete(knowledgeChunks)
    .where(inArray(knowledgeChunks.id, [...DEMO_KNOWLEDGE_CHUNK_IDS]));
  await tx.delete(knowledgeChunks).where(inArray(knowledgeChunks.agentId, [...DEMO_AGENT_IDS]));
  await tx
    .delete(knowledgeDocuments)
    .where(inArray(knowledgeDocuments.id, [...DEMO_KNOWLEDGE_DOC_IDS]));
  await tx
    .delete(knowledgeDocuments)
    .where(inArray(knowledgeDocuments.agentId, [...DEMO_AGENT_IDS]));

  // Junction rows for demo agents (skills/MCP library rows themselves stay if shared).
  await tx.delete(agentSkills).where(inArray(agentSkills.agentId, [...DEMO_AGENT_IDS]));
  await tx
    .delete(agentMcpConnections)
    .where(inArray(agentMcpConnections.agentId, [...DEMO_AGENT_IDS]));
  await tx.delete(skills).where(sql`${skills.actor} = ${DEMO_ACTOR}`);
  await tx.delete(mcpConnections).where(sql`${mcpConnections.actor} = ${DEMO_ACTOR}`);

  await tx.delete(usageCounters).where(inArray(usageCounters.agentId, [...DEMO_AGENT_IDS]));
  await tx.delete(recipientConsents).where(inArray(recipientConsents.agentId, [...DEMO_AGENT_IDS]));
  await tx.delete(credentials).where(inArray(credentials.agentId, [...DEMO_AGENT_IDS]));
  await tx.delete(configurations).where(inArray(configurations.agentId, [...DEMO_AGENT_IDS]));
  await tx.delete(agents).where(inArray(agents.id, [...DEMO_AGENT_IDS]));

  await tx.delete(audit).where(inArray(audit.id, demoAuditIds));
  await tx.delete(audit).where(sql`${audit.actor} = ${DEMO_ACTOR}`);
}
