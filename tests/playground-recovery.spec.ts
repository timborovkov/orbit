import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import postgres from 'postgres';

import { orbitTestWebServer } from '../playwright.config';
import { openWorkspaceTab } from './workspace-nav';

const sql = postgres(orbitTestWebServer.env.DATABASE_URL);

test.afterAll(async () => {
  await sql.end();
});

test('Playground recovers a queued simulation and shows its persisted result', async ({ page }) => {
  await sql`TRUNCATE evaluation_comparisons, evaluation_cases, agent_activity_events, follow_ups, outbound_actions, source_events, discovery_cursors, email_messages, email_threads, email_mailboxes, knowledge_chunks, knowledge_documents, recipient_consents, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, agent_skills, agent_mcp_connections, skills, mcp_connections, sessions, agents, audit, login_attempts`;
  await sql`UPDATE controls SET paused=false`;

  await page.goto('/login');
  await page.getByLabel(/^Email/).fill(orbitTestWebServer.env.ORBIT_ADMIN_EMAIL);
  await page.getByLabel(/^Password/).fill(orbitTestWebServer.env.ORBIT_ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  await page.getByLabel(/^Name/).fill('Recovery fixture');
  await page.getByLabel(/^Mission/).fill('Answer support questions.');
  await page.getByRole('button', { name: 'Create shadow agent' }).click();
  await page.getByRole('link', { name: 'Recovery fixture', exact: true }).click();
  await openWorkspaceTab(page, 'Playground');

  const [configuration] = await sql<{ id: string; agentId: string }[]>`
    SELECT id, agent_id AS "agentId" FROM agent_configurations
  `;
  const route = `/api/agents/${configuration.agentId}/chat`;
  const input = 'How do I reset my password?';
  const body = { input, configurationId: configuration.id, recipients: [] };
  const invalid = await page.request.post(route, {
    headers: { origin: 'http://localhost:3000' },
    data: { ...body, messages: [] },
  });
  expect(invalid.status()).toBe(400);

  await page.getByLabel('Post or question', { exact: true }).fill(input);
  const request = page.waitForRequest(
    (candidate) => candidate.method() === 'POST' && new URL(candidate.url()).pathname === route,
  );
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  expect((await request).postDataJSON()).toEqual(body);
  const latest = page.getByRole('region', { name: 'Latest persisted run' });
  await expect(latest.getByRole('status')).toHaveText('queued');
  const [run] = await sql<{ id: string }[]>`SELECT id FROM simulation_runs WHERE input=${input}`;

  await page.getByRole('button', { name: 'Stop watching', exact: true }).click();
  await expect(page.getByText('Stopped watching. Inference may continue.')).toBeVisible();
  await page.getByRole('link', { name: 'Open run in History', exact: true }).click();
  const historyRun = page.locator(`#run-${run.id}`);
  await expect(historyRun.locator('.run-content')).toBeVisible();
  await expect(historyRun.locator('.state-label')).toHaveText('queued');

  // Verify the History link survives a workspace refresh before reloading the pending run.
  await page.waitForResponse(
    (response) =>
      response.request().headers().rsc === '1' &&
      new URL(response.url()).searchParams.get('run') === run.id,
  );
  await expect(page).toHaveURL(new RegExp(`[?&]run=${run.id}`));
  await page.reload();
  await expect(historyRun.locator('.run-content')).toBeVisible();
  await openWorkspaceTab(page, 'Playground');
  await expect(latest.getByRole('status')).toHaveText('queued');
  await expect(latest.locator('summary').first()).toContainText(input);
  await latest.locator('summary').first().click();

  execFileSync(
    'bun',
    ['--no-env-file', require.resolve('./fixtures/playground-worker.ts'), run.id],
    {
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: orbitTestWebServer.env.DATABASE_URL,
        OPENROUTER_API_KEY: 'test-only-fixture',
      },
      timeout: 10000,
    },
  );
  await expect(latest.getByRole('status')).toHaveText('completed');
  await expect(latest.getByText('Here is your deterministic support reply.')).toBeVisible();
  await expect(page.getByText('Simulation queued. Watching for results…')).toBeHidden();
});
