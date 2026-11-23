import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  pgView,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

import type { AgentBudgets } from '@/lib/budgets';
import type { KnowledgeContentKind, KnowledgeDocumentStatus } from '@/lib/knowledge/types';
import type { LifecycleState } from '@/lib/lifecycle';
import type { McpToolAllowlistJson } from '@/lib/mcp-allowlist';
import type { ConsentScope } from '@/lib/policy/scopes';
import type { CrawlStatus, WebTool } from '@/lib/research';
import type { AgentConfig } from '@/lib/runtime/config';
import type {
  FollowUpOutcomeKind,
  FollowUpSource,
  FollowUpStatus,
} from '@/lib/runtime/follow-ups/types';
import type {
  IntroductionDecision,
  IntroductionDisclosure,
} from '@/lib/runtime/introductions/types';
import type {
  MemoryNote,
  MemorySubject,
  PersonMemoryField,
  RecalledMemory,
} from '@/lib/runtime/memory/types';
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
  memoryFactRetentionDays: integer('memory_fact_retention_days'),
  memoryNoteRetentionDays: integer('memory_note_retention_days'),
  memoryOutcomeRetentionDays: integer('memory_outcome_retention_days'),
  memoryMaintenanceIntervalDays: integer('memory_maintenance_interval_days')
    .$type<1 | 7>()
    .notNull()
    .default(1),
  memoryNextMaintenanceAt: timestamp('memory_next_maintenance_at', { withTimezone: true }),
  webCrawlScopes: jsonb('web_crawl_scopes').$type<string[]>().notNull().default([]),
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

export const xReplyCredentials = pgTable('x_reply_credentials', {
  agentId: uuid('agent_id')
    .primaryKey()
    .references(() => agents.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().unique(),
  username: text('username').notNull(),
  encryptedToken: text('encrypted_token').notNull(),
});

export const firecrawlCredentials = pgTable('agent_firecrawl_credentials', {
  agentId: uuid('agent_id')
    .primaryKey()
    .references(() => agents.id, { onDelete: 'cascade' }),
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

export const runs = pgTable(
  'simulation_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    configurationId: uuid('configuration_id')
      .notNull()
      .references(() => configurations.id),
    origin: text('origin')
      .$type<'playground' | 'email' | 'discovery' | 'replay' | 'channel'>()
      .notNull()
      .default('playground'),
    channel: text('channel'),
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
  },
  (table) => [unique().on(table.agentId, table.id)],
);

export const people = pgTable('people', {
  id: uuid('id').defaultRandom().primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type PersonChannel = string;
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
    unique().on(table.agentId, table.id),
    unique().on(table.agentId, table.resendEmailId),
    unique().on(table.agentId, table.id),
    foreignKey({
      columns: [table.agentId, table.threadId],
      foreignColumns: [emailThreads.agentId, emailThreads.id],
    }).onDelete('cascade'),
  ],
);

export type EvaluationCaseSource = 'playground' | 'email' | 'channel';
export type EvaluationComparisonStatus = 'queued' | 'running' | 'completed' | 'failed';

export const evaluationCases = pgTable('evaluation_cases', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  sourceKind: text('source_kind').$type<EvaluationCaseSource>().notNull(),
  sourceChannel: text('source_channel'),
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
  memorySnapshot: jsonb('memory_snapshot').$type<RecalledMemory[]>(),
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

export const introductionProposals = pgTable(
  'introduction_proposals',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => actionIntents.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').notNull(),
    runId: uuid('run_id').notNull(),
    firstPersonId: uuid('first_person_id')
      .notNull()
      .references(() => people.id),
    secondPersonId: uuid('second_person_id')
      .notNull()
      .references(() => people.id),
    firstDisclosure: jsonb('first_disclosure').$type<IntroductionDisclosure>().notNull(),
    secondDisclosure: jsonb('second_disclosure').$type<IntroductionDisclosure>().notNull(),
    rationale: text('rationale').notNull(),
    reviewIntentId: uuid('review_intent_id')
      .unique()
      .references(() => actionIntents.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique().on(table.id, table.agentId),
    foreignKey({
      columns: [table.agentId, table.runId],
      foreignColumns: [runs.agentId, runs.id],
    }).onDelete('cascade'),
    index('introduction_proposals_created').on(table.createdAt.desc(), table.id.desc()),
  ],
);

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
  dispatchAttempt: integer('dispatch_attempt'),
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
    introductionId: uuid('introduction_id'),
    introductionDecision: text('introduction_decision').$type<IntroductionDecision>(),
  },
  (table) => [
    unique('recipient_consents_scope_key')
      .on(table.agentId, table.recipient, table.scope, table.introductionId)
      .nullsNotDistinct(),
    foreignKey({
      columns: [table.introductionId, table.agentId],
      foreignColumns: [introductionProposals.id, introductionProposals.agentId],
    }).onDelete('cascade'),
  ],
);

export const knowledgeLibraries = pgTable('knowledge_libraries', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
});

export const knowledgeLibraryGrants = pgTable(
  'knowledge_library_grants',
  {
    libraryId: uuid('library_id')
      .notNull()
      .references(() => knowledgeLibraries.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.libraryId, table.agentId] })],
);

export const webCrawls = pgTable(
  'web_crawls',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id').notNull(),
    runId: uuid('run_id').notNull(),
    intentId: uuid('intent_id')
      .notNull()
      .unique()
      .references(() => actionIntents.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').references(() => jobs.id),
    seedUrl: text('seed_url').notNull(),
    originHash: text('origin_hash').notNull(),
    providerJobId: text('provider_job_id'),
    pageLimit: integer('page_limit').notNull(),
    depthLimit: integer('depth_limit').notNull(),
    status: text('status').$type<CrawlStatus>().notNull().default('queued'),
    completedPages: integer('completed_pages').notNull().default(0),
    discoveredPages: integer('discovered_pages').notNull().default(0),
    creditsUsed: integer('credits_used'),
    cursor: integer('cursor').notNull().default(0),
    pollRequests: integer('poll_requests').notNull().default(0),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    cancellationSentAt: timestamp('cancellation_sent_at', { withTimezone: true }),
    reason: text('reason'),
    deadline: timestamp('deadline', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'web_crawls_owned_run_fk',
      columns: [table.agentId, table.runId],
      foreignColumns: [runs.agentId, runs.id],
    }).onDelete('cascade'),
    index('web_crawls_agent_created_idx').on(table.agentId, table.createdAt),
    uniqueIndex('web_crawls_one_active_idx')
      .on(table.agentId)
      .where(sql`status IN ('queued','submitting','running','cancelling')`),
  ],
);

export const webCitations = pgTable(
  'web_citations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id').notNull(),
    runId: uuid('run_id').notNull(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => actionIntents.id, { onDelete: 'cascade' }),
    crawlId: uuid('crawl_id').references(() => webCrawls.id, { onDelete: 'cascade' }),
    tool: text('tool').$type<WebTool>().notNull(),
    rank: integer('rank').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    excerpt: text('excerpt').notNull(),
    content: text('content'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'web_citations_owned_run_fk',
      columns: [table.agentId, table.runId],
      foreignColumns: [runs.agentId, runs.id],
    }).onDelete('cascade'),
    unique('web_citations_intent_url_unique').on(table.intentId, table.url),
    index('web_citations_run_idx').on(table.agentId, table.runId),
  ],
);

export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    libraryId: uuid('library_id').references(() => knowledgeLibraries.id),
    webCitationId: uuid('web_citation_id').references(() => webCitations.id, {
      onDelete: 'set null',
    }),
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
  },
  (table) => [
    unique('knowledge_documents_web_import_unique').on(table.libraryId, table.webCitationId),
  ],
);

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
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

export type SourceEventProvider = string;

export const sourceEvents = pgTable(
  'source_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<SourceEventProvider>().notNull(),
    providerEventId: text('provider_event_id').notNull(),
    accountId: text('account_id'),
    threadId: text('thread_id'),
    admissionStatus: text('admission_status').$type<
      'pending' | 'deferred' | 'admitted' | 'rejected'
    >(),
    admissionReason: text('admission_reason'),
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
    unique('source_events_delivery_key')
      .on(table.agentId, table.provider, table.accountId, table.providerEventId)
      .nullsNotDistinct(),
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

export const agentMemories = pgTable(
  'agent_memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    subjectKind: text('subject_kind').$type<MemorySubject>().notNull(),
    subject: text('subject').notNull(),
    topic: text('topic').notNull(),
    identityKey: text('identity_key').notNull(),
    fact: text('fact').notNull(),
    personField: text('person_field').$type<PersonMemoryField>(),
    personValue: text('person_value'),
    note: jsonb('note').$type<MemoryNote>(),
    quote: text('quote').notNull(),
    runId: uuid('run_id').notNull(),
    sourceKind: text('source_kind').notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceAt: timestamp('source_at', { withTimezone: true }).notNull(),
    learnedAt: timestamp('learned_at', { withTimezone: true }).notNull().defaultNow(),
    expiresOn: date('expires_on'),
    reviewOn: date('review_on'),
    correctedBy: text('corrected_by'),
    correctedAt: timestamp('corrected_at', { withTimezone: true }),
    revision: uuid('revision').notNull().defaultRandom(),
    embedding: vector('embedding', { dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS }),
    embeddingModel: text('embedding_model'),
  },
  (table) => [
    unique().on(table.agentId, table.subjectKind, table.identityKey),
    unique().on(table.agentId, table.id),
    foreignKey({
      columns: [table.agentId, table.runId],
      foreignColumns: [runs.agentId, runs.id],
    }).onDelete('cascade'),
  ],
);

export const agentMemoryEvidenceVersions = pgView('agent_memory_evidence_versions', {
  agentId: uuid('agent_id').notNull(),
  id: uuid('id').notNull(),
  revision: uuid('revision').notNull(),
  subject: text('subject').notNull(),
  topic: text('topic').notNull(),
  quote: text('quote').notNull(),
  sourceAt: timestamp('source_at', { withTimezone: true }).notNull(),
  correctedBy: text('corrected_by'),
  runId: uuid('run_id').notNull(),
  sourceKind: text('source_kind').notNull(),
  sourceId: uuid('source_id').notNull(),
}).existing();

const memoryEvidenceColumns = () => ({
  sourceKind: text('source_kind').notNull(),
  sourceId: uuid('source_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  runId: uuid('run_id').notNull(),
  sourceAt: timestamp('source_at', { withTimezone: true }).notNull(),
  title: text('title'),
  author: text('author'),
  body: text('body').notNull(),
  label: text('label').notNull(),
  href: text('href').notNull(),
  linkLabel: text('link_label').notNull(),
  channel: text('channel').notNull(),
  personIdentityId: uuid('person_identity_id'),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
});
export const runMemoryEvidence = pgView('run_memory_evidence', memoryEvidenceColumns()).existing();
export const memoryEvidence = pgView('memory_evidence', memoryEvidenceColumns()).existing();

export const personMemoryEvidence = pgView('person_memory_evidence', {
  memoryId: uuid('memory_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  personId: uuid('person_id').notNull(),
}).existing();

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
  channel: text('channel'),
  accountId: text('account_id'),
  conversationId: text('conversation_id'),
  anchorId: uuid('anchor_id'),
  originatingRunId: uuid('originating_run_id').references(() => runs.id, { onDelete: 'set null' }),
  replyEventId: uuid('reply_event_id').references(() => sourceEvents.id, { onDelete: 'set null' }),
  replyEmailId: uuid('reply_email_id').references(() => emailMessages.id, { onDelete: 'set null' }),
  continuationRunId: uuid('continuation_run_id').references(() => runs.id, {
    onDelete: 'set null',
  }),
  draftRunId: uuid('draft_run_id')
    .unique()
    .references(() => runs.id, { onDelete: 'set null' }),
  approvalIntentId: uuid('approval_intent_id').references(() => actionIntents.id, {
    onDelete: 'set null',
  }),
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
