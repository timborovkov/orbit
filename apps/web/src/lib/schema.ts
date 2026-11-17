import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import type { AgentBudgets } from '@/lib/budgets';
import type { LifecycleState } from '@/lib/lifecycle';
import type { AgentConfig } from '@/lib/runtime/config';
import type { SimulationResult } from '@/lib/runtime/simulation';

export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  email: text('email').notNull(),
  credentialHash: text('credential_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const agents = pgTable('agents', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  mission: text('mission').notNull(),
  pictureKey: text('picture_key'),
  lifecycle: text('lifecycle').$type<LifecycleState>().notNull().default('shadow'),
  budgets: jsonb('budgets').$type<AgentBudgets>().notNull(),
  enabledTools: jsonb('enabled_tools').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const controls = pgTable('controls', {
  id: integer('id').primaryKey(),
  paused: boolean('paused').notNull().default(true),
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

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';

export const runs = pgTable('simulation_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id),
  configurationId: uuid('configuration_id')
    .notNull()
    .references(() => configurations.id),
  input: text('input').notNull(),
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
