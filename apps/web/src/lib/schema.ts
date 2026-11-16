import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
  status: text('status').notNull().default('paused'),
  mode: text('mode').notNull().default('shadow'),
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
