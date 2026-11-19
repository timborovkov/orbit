import { expect, test } from '@playwright/test';
import postgres from 'postgres';

const sql = postgres('postgres://orbit:orbit_dev@127.0.0.1:5432/orbit_test');
test.beforeAll(async () => {
  await sql`TRUNCATE source_events, discovery_cursors, email_messages, email_threads, email_mailboxes, knowledge_chunks, knowledge_documents, recipient_consents, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, agent_skills, agent_mcp_connections, skills, mcp_connections, sessions, agents, audit, login_attempts`;
  await sql`UPDATE controls SET paused=true`;
});
test.afterAll(async () => {
  await sql.end();
});
test('local bypass skips login and sessions while preserving admin actions and audit identity', async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(90000);
  await page.goto('/login');
  await expect(page).toHaveURL('http://127.0.0.1:3001/');
  await expect(page.getByRole('status')).toContainText(
    'Authentication disabled · Local development · local-admin@example.test',
  );
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  await page.getByLabel(/^Name/).fill('Local agent');
  await page.getByLabel(/^Mission/).fill('Exercise local development against PostgreSQL.');
  await page.getByRole('button', { name: 'Create shadow agent' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Local agent', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Release global pause' }).click();
  await expect(page.getByRole('button', { name: 'Pause all outbound actions' })).toBeVisible();
  const events = await sql`SELECT actor FROM audit`;
  expect(events.length).toBe(2);
  expect(events.every((e) => e.actor === 'local-admin@example.test')).toBe(true);
  expect((await sql`SELECT count(*)::int AS count FROM sessions`)[0].count).toBe(0);
  expect((await sql`SELECT count(*)::int AS count FROM login_attempts`)[0].count).toBe(0);
  expect((await context.cookies()).some((c) => c.name === 'orbit-session')).toBe(false);
  const spoofed = await request.get('/', { headers: { host: 'remote.example.com' } });
  expect(await spoofed.text()).not.toContain('Manage your agents and workspace activity.');
});
