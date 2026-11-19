import { inArray, sql } from 'drizzle-orm';

import {
  actionIntents,
  agentMcpConnections,
  agents,
  agentSkills,
  audit,
  configurations,
  credentials,
  jobs,
  knowledgeChunks,
  knowledgeDocuments,
  mcpConnections,
  policyDecisions,
  recipientConsents,
  runs,
  skills,
  usageCounters,
} from '@/lib/schema';
import {
  DEMO_ACTOR,
  DEMO_AGENT_IDS,
  DEMO_AUDIT,
  DEMO_INTENTS,
  DEMO_JOBS,
  DEMO_KNOWLEDGE_CHUNK_IDS,
  DEMO_KNOWLEDGE_DOC_IDS,
  DEMO_POLICY,
  DEMO_RUNS,
} from '@/lib/seed/ids';
import type { SeedContext } from '@/lib/seed/types';

const demoJobIds = Object.values(DEMO_JOBS);
const demoRunIds = Object.values(DEMO_RUNS);
const demoIntentIds = Object.values(DEMO_INTENTS);
const demoPolicyIds = Object.values(DEMO_POLICY);
const demoAuditIds = Object.values(DEMO_AUDIT);

/**
 * Delete only demo-owned rows (fixed IDs / DEMO_ACTOR). Never touches other agents.
 */
export async function resetDemoData(ctx: SeedContext): Promise<void> {
  const { tx } = ctx;

  await tx.delete(policyDecisions).where(inArray(policyDecisions.id, demoPolicyIds));
  await tx.delete(policyDecisions).where(inArray(policyDecisions.agentId, [...DEMO_AGENT_IDS]));

  await tx.delete(actionIntents).where(inArray(actionIntents.id, demoIntentIds));
  await tx.delete(actionIntents).where(inArray(actionIntents.agentId, [...DEMO_AGENT_IDS]));

  // Clear run → job FK before deleting jobs.
  await tx.update(runs).set({ jobId: null }).where(inArray(runs.id, demoRunIds));
  await tx.delete(runs).where(inArray(runs.id, demoRunIds));
  await tx.delete(runs).where(inArray(runs.agentId, [...DEMO_AGENT_IDS]));

  await tx.delete(jobs).where(inArray(jobs.id, demoJobIds));
  await tx.delete(jobs).where(sql`${jobs.idempotencyKey} LIKE ${'orbit-demo:%'}`);

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
