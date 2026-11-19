import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

import type { AgentBudgets } from '@/lib/budgets';
import type { KnowledgeContentKind, KnowledgeDocumentStatus } from '@/lib/knowledge/types';
import type { LifecycleState } from '@/lib/lifecycle';
import type { McpToolAllowlistJson } from '@/lib/mcp-allowlist';
import type { ConsentScope } from '@/lib/policy/scopes';
import type { AgentConfig } from '@/lib/runtime/config';
import type { SimulationResult } from '@/lib/runtime/simulation';

const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1536;

export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  email: text('email').notNull(),
  credentialHash: text('credential_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export type ApprovalOnReject = 'continue' | 'end';
export interface ApprovalSettings {
  approvalTools: string[];
  approvalExpiresAfterHours: number | null;
  approvalOnReject: ApprovalOnReject;
  approvalSpendCents: number | null;
}

export const agents = pgTable('agents', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  mission: text('mission').notNull(),
  pictureKey: text('picture_key'),
  lifecycle: text('lifecycle').$type<LifecycleState>().notNull().default('shadow'),
  budgets: jsonb('budgets').$type<AgentBudgets>().notNull(),
  approvalTools: jsonb('approval_tools').$type<string[]>().notNull().default([]),
  consentRequiredTools: jsonb('consent_required_tools')
    .$type<ConsentScope[]>()
    .notNull()
    .default(['introduce', 'escalate']),
  /** Optional hours until a pending approval auto-rejects; null disables expiry. */
  approvalExpiresAfterHours: integer('approval_expires_after_hours'),
  approvalOnReject: text('approval_on_reject')
    .$type<ApprovalOnReject>()
    .notNull()
    .default('continue'),
  /** When set, write actions need approval once day spend reaches this many USD cents. */
  approvalSpendCents: integer('approval_spend_cents'),
  enabledTools: jsonb('enabled_tools').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const controls = pgTable('controls', {
  id: integer('id').primaryKey(),
  paused: boolean('paused').notNull().default(true),
  /** Optional workspace-wide approval tool names; merged with per-agent lists. */
  approvalTools: jsonb('approval_tools').$type<string[]>().notNull().default([]),
});

export const audit = pgTable('audit', {
  id: uuid('id').defaultRandom().primaryKey(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const templates = pgTable('templates', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  config: jsonb('config').$type<AgentConfig>().notNull(),
  revision: integer('revision').notNull().default(1),
});

export const configurations = pgTable(
  'agent_configurations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    version: integer('version').notNull(),
    config: jsonb('config').$type<AgentConfig>().notNull(),
    approvalSettings: jsonb('approval_settings').$type<ApprovalSettings>(),
    actor: text('actor').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique().on(table.agentId, table.version)],
);

export const credentials = pgTable('agent_credentials', {
  agentId: uuid('agent_id')
    .primaryKey()
    .references(() => agents.id),
  encryptedKey: text('encrypted_key').notNull(),
});

export const jobs = pgTable('jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  type: text('type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  availableAt: timestamp('available_at', { withTimezone: true }).defaultNow().notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
  claimedBy: text('claimed_by'),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  lastError: text('last_error'),
  idempotencyKey: text('idempotency_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type RunStatus =
  'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'interrupted';

export const runs = pgTable('simulation_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id),
  configurationId: uuid('configuration_id')
    .notNull()
    .references(() => configurations.id),
  input: text('input').notNull(),
  recipients: jsonb('recipients').$type<string[]>().notNull().default([]),
  status: text('status').$type<RunStatus>().notNull().default('queued'),
  result: jsonb('result').$type<SimulationResult>().notNull(),
  actor: text('actor').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  jobId: uuid('job_id').references(() => jobs.id),
  deferReason: text('defer_reason'),
  /** Rotated whenever a worker takes ownership of a running execution; fences stale writers. */
  executionToken: uuid('execution_token'),
});

export const actionIntents = pgTable('action_intents', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id),
  runId: uuid('run_id').references(() => runs.id),
  actionType: text('action_type').notNull(),
  recipients: jsonb('recipients').$type<string[]>().notNull().default([]),
  reviewStatus: text('review_status').$type<'pending' | 'approved' | 'rejected'>(),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewExpiresAt: timestamp('review_expires_at', { withTimezone: true }),
  reviewNote: text('review_note'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  decision: text('decision').notNull(),
  reasons: jsonb('reasons').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const policyDecisions = pgTable('policy_decisions', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id),
  runId: uuid('run_id'),
  actionType: text('action_type').notNull(),
  decision: text('decision').notNull(),
  reasons: jsonb('reasons').$type<string[]>().notNull().default([]),
  intentId: uuid('intent_id').references(() => actionIntents.id),
  actor: text('actor').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const usageCounters = pgTable(
  'usage_counters',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    period: text('period').notNull(),
    periodStart: date('period_start').notNull(),
    spendMicros: bigint('spend_micros', { mode: 'bigint' }).notNull().default(BigInt(0)),
    requests: integer('requests').notNull().default(0),
    outboundActions: integer('outbound_actions').notNull().default(0),
  },
  (table) => [unique().on(table.agentId, table.period, table.periodStart)],
);

export const recipientConsents = pgTable(
  'recipient_consents',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    recipient: text('recipient').notNull(),
    scope: text('scope').$type<ConsentScope>().notNull(),
    evidence: text('evidence').notNull(),
    granted: boolean('granted').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    actor: text('actor').notNull(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.recipient, table.scope] })],
);

export const knowledgeDocuments = pgTable('knowledge_documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  title: text('title').notNull(),
  contentKind: text('content_kind').$type<KnowledgeContentKind>().notNull(),
  mimeType: text('mime_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  objectKey: text('object_key').notNull(),
  revision: uuid('revision').defaultRandom().notNull(),
  processingToken: uuid('processing_token'),
  status: text('status').$type<KnowledgeDocumentStatus>().notNull().default('pending'),
  error: text('error'),
  chunkCount: integer('chunk_count').notNull().default(0),
  embeddedCount: integer('embedded_count').notNull().default(0),
  contentHash: text('content_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
});

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    sourceFilename: text('source_filename').notNull(),
    sourceTitle: text('source_title').notNull(),
    page: integer('page'),
    section: text('section'),
    startOffset: integer('start_offset').notNull(),
    endOffset: integer('end_offset').notNull(),
    embedding: vector('embedding', { dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS }),
    embeddingModel: text('embedding_model'),
    embeddingDimensions: integer('embedding_dimensions'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique().on(table.documentId, table.chunkIndex)],
);

export const skills = pgTable('skills', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull().unique(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  body: text('body').notNull(),
  version: integer('version').notNull().default(1),
  actor: text('actor').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const agentSkills = pgTable(
  'agent_skills',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.skillId] })],
);

export type McpTransport = 'http' | 'sse';

export const mcpConnections = pgTable('mcp_connections', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull().unique(),
  url: text('url').notNull(),
  transport: text('transport').$type<McpTransport>().notNull(),
  encryptedHeaders: text('encrypted_headers'),
  toolAllowlist: jsonb('tool_allowlist').$type<McpToolAllowlistJson>(),
  actor: text('actor').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const agentMcpConnections = pgTable(
  'agent_mcp_connections',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => mcpConnections.id, { onDelete: 'cascade' }),
    toolNames: text('tool_names').array().notNull().default([]),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.connectionId] })],
);
