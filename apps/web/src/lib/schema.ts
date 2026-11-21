import {
  bigint,
  boolean,
  date,
  foreignKey,
  index,
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
import type {
  FollowUpOutcomeKind,
  FollowUpSource,
  FollowUpStatus,
} from '@/lib/runtime/follow-ups/types';
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
  origin: text('origin')
    .$type<'playground' | 'email' | 'discovery' | 'replay'>()
    .notNull()
    .default('playground'),
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

export const people = pgTable('people', {
  id: uuid('id').defaultRandom().primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type PersonChannel = 'email' | 'x';
export type PersonEvidence = { channel: PersonChannel; sourceId: string };

export const personIdentities = pgTable(
  'person_identities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id),
    homePersonId: uuid('home_person_id')
      .notNull()
      .unique()
      .references(() => people.id),
    channel: text('channel').$type<PersonChannel>().notNull(),
    identityKey: text('identity_key').notNull(),
    linkState: text('link_state')
      .$type<'standalone' | 'inferred' | 'confirmed'>()
      .notNull()
      .default('standalone'),
    linkedViaId: uuid('linked_via_id'),
    revision: integer('revision').notNull().default(0),
  },
  (table) => [
    unique().on(table.channel, table.identityKey),
    foreignKey({ columns: [table.linkedViaId], foreignColumns: [table.id] }),
    index('person_identities_person').on(table.personId),
  ],
);

export const personContacts = pgTable(
  'person_contacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id),
    kind: text('kind').$type<'phone' | 'instagram'>().notNull(),
    label: text('label').notNull(),
    providerAccountId: text('provider_account_id'),
  },
  (table) => [
    unique().on(table.kind, table.providerAccountId),
    unique().on(table.personId, table.kind, table.label),
  ],
);

export const personIdentityChanges = pgTable('person_identity_changes', {
  id: uuid('id').defaultRandom().primaryKey(),
  identityId: uuid('identity_id')
    .notNull()
    .references(() => personIdentities.id),
  fromPersonId: uuid('from_person_id')
    .notNull()
    .references(() => people.id),
  toPersonId: uuid('to_person_id')
    .notNull()
    .references(() => people.id),
  action: text('action').$type<'infer' | 'confirm' | 'unlink' | 'rollback'>().notNull(),
  actor: text('actor').notNull(),
  reason: text('reason').notNull(),
  evidence: jsonb('evidence').$type<PersonEvidence[]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const personLinkRejections = pgTable(
  'person_link_rejections',
  {
    firstIdentityId: uuid('first_identity_id')
      .notNull()
      .references(() => personIdentities.id),
    secondIdentityId: uuid('second_identity_id')
      .notNull()
      .references(() => personIdentities.id),
  },
  (table) => [primaryKey({ columns: [table.firstIdentityId, table.secondIdentityId] })],
);

export const emailMailboxes = pgTable('email_mailboxes', {
  agentId: uuid('agent_id')
    .primaryKey()
    .references(() => agents.id, { onDelete: 'cascade' }),
  address: text('address').notNull().unique(),
  enabled: boolean('enabled').notNull(),
});

export const emailThreads = pgTable(
  'email_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provisional: boolean('provisional').notNull().default(false),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
  },
  (table) => [unique().on(table.agentId, table.id)],
);

export const emailMessages = pgTable(
  'email_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    resendEmailId: text('resend_email_id').notNull(),
    event: jsonb('event').$type<Record<string, unknown>>().notNull(),
    sender: text('sender').notNull(),
    personIdentityId: uuid('person_identity_id').references(() => personIdentities.id),
    personClaim: text('person_claim'),
    subject: text('subject').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    configurationId: uuid('configuration_id').references(() => configurations.id, {
      onDelete: 'set null',
    }),
    receiveJobId: uuid('receive_job_id')
      .unique()
      .references(() => jobs.id, { onDelete: 'set null' }),
    runId: uuid('run_id')
      .unique()
      .references(() => runs.id, { onDelete: 'set null' }),
    threadId: uuid('thread_id').notNull(),
    messageId: text('message_id'),
    inReplyTo: text('in_reply_to').array().notNull().default([]),
    referenceIds: text('reference_ids').array().notNull().default([]),
    body: text('body'),
    skipReason: text('skip_reason'),
    waitingForCapacity: boolean('waiting_for_capacity').notNull().default(false),
  },
  (table) => [
    unique().on(table.agentId, table.resendEmailId),
    unique().on(table.agentId, table.id),
    foreignKey({
      columns: [table.agentId, table.threadId],
      foreignColumns: [emailThreads.agentId, emailThreads.id],
    }).onDelete('cascade'),
  ],
);

export type EvaluationCaseSource = 'playground' | 'email';
export type EvaluationComparisonStatus = 'queued' | 'running' | 'completed' | 'failed';

export const evaluationCases = pgTable('evaluation_cases', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  sourceKind: text('source_kind').$type<EvaluationCaseSource>().notNull(),
  sourceRunId: uuid('source_run_id').references(() => runs.id, { onDelete: 'set null' }),
  sourceEmailMessageId: uuid('source_email_message_id').references(() => emailMessages.id, {
    onDelete: 'set null',
  }),
  input: text('input').notNull(),
  recipients: jsonb('recipients').$type<string[]>().notNull().default([]),
  actor: text('actor').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const evaluationComparisons = pgTable('evaluation_comparisons', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  caseId: uuid('case_id')
    .notNull()
    .references(() => evaluationCases.id, { onDelete: 'cascade' }),
  leftConfigurationId: uuid('left_configuration_id')
    .notNull()
    .references(() => configurations.id),
  rightConfigurationId: uuid('right_configuration_id')
    .notNull()
    .references(() => configurations.id),
  leftRunId: uuid('left_run_id').references(() => runs.id, { onDelete: 'set null' }),
  rightRunId: uuid('right_run_id').references(() => runs.id, { onDelete: 'set null' }),
  status: text('status').$type<EvaluationComparisonStatus>().notNull().default('queued'),
  actor: text('actor').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
  error: text('error'),
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

export const outboundActions = pgTable('outbound_actions', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  intentId: uuid('intent_id')
    .notNull()
    .unique()
    .references(() => actionIntents.id, { onDelete: 'cascade' }),
  actionType: text('action_type').notNull(),
  status: text('status').$type<'queued' | 'sending' | 'sent' | 'failed' | 'blocked'>().notNull(),
  reason: text('reason'),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  body: text('body').notNull(),
  emailMessageId: uuid('email_message_id').references(() => emailMessages.id, {
    onDelete: 'set null',
  }),
  threadId: uuid('thread_id'),
  provider: text('provider'),
  providerMessageId: text('provider_message_id'),
  providerResult: jsonb('provider_result').$type<Record<string, unknown>>(),
  jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
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

export type SourceEventProvider = 'x';

export const sourceEvents = pgTable(
  'source_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<SourceEventProvider>().notNull(),
    providerEventId: text('provider_event_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    text: text('text').notNull(),
    authorId: text('author_id'),
    authorUsername: text('author_username'),
    authorName: text('author_name'),
    personIdentityId: uuid('person_identity_id').references(() => personIdentities.id),
    personClaim: text('person_claim'),
    providerCreatedAt: timestamp('provider_created_at', { withTimezone: true }),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).defaultNow().notNull(),
    runId: uuid('run_id')
      .unique()
      .references(() => runs.id, { onDelete: 'set null' }),
  },
  (table) => [
    unique().on(table.agentId, table.provider, table.providerEventId),
    unique().on(table.agentId, table.id),
  ],
);

export const personRelationshipNotes = pgTable(
  'person_relationship_notes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id').notNull(),
    emailMessageId: uuid('email_message_id').unique(),
    sourceEventId: uuid('source_event_id').unique(),
    summary: text('summary').notNull(),
    excerpt: text('excerpt').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.agentId, table.emailMessageId],
      foreignColumns: [emailMessages.agentId, emailMessages.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.agentId, table.sourceEventId],
      foreignColumns: [sourceEvents.agentId, sourceEvents.id],
    }).onDelete('cascade'),
  ],
);

export const discoveryCursors = pgTable(
  'discovery_cursors',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<SourceEventProvider>().notNull(),
    sinceId: text('since_id'),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    lastStatus: text('last_status').notNull().default('idle'),
    lastError: text('last_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.provider] })],
);

export const followUps = pgTable('follow_ups', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  source: text('source').$type<FollowUpSource>().notNull().default('admin'),
  createdBy: text('created_by').notNull(),
  subject: text('subject').notNull(),
  note: text('note').notNull().default(''),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  status: text('status').$type<FollowUpStatus>().notNull().default('scheduled'),
  attempts: integer('attempts').notNull().default(0),
  jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledBy: text('cancelled_by'),
  cancelReason: text('cancel_reason'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  outcome: text('outcome'),
  outcomeKind: text('outcome_kind').$type<FollowUpOutcomeKind>(),
  waitForEvent: text('wait_for_event'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const agentActivityEvents = pgTable('agent_activity_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  summary: text('summary').notNull(),
  detail: text('detail'),
  followUpId: uuid('follow_up_id').references(() => followUps.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
