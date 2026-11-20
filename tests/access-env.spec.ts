import { expect, test } from '@playwright/test';
import postgres from 'postgres';

import { capturePage } from './screenshot';
import { openAccessSection, openWorkspaceTab } from './workspace-nav';

const sql = postgres('postgres://orbit:orbit_dev@localhost:5432/orbit_test');
test.afterAll(async () => {
  await sql.end();
});

test('Access tab shows environment default and agent override without revealing key values', async ({
  page,
}) => {
  test.setTimeout(90000);
  await sql`TRUNCATE outbound_actions, source_events, discovery_cursors, email_messages, email_threads, email_mailboxes, knowledge_chunks, knowledge_documents, recipient_consents, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, agent_skills, agent_mcp_connections, skills, mcp_connections, sessions, agents, audit, login_attempts`;
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill('admin@example.com');
  await page.getByLabel(/^Password/).fill('test-only-password-123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  await page.getByLabel('Template', { exact: true }).click();
  await page.getByRole('option', { name: 'Blank', exact: true }).click();
  await page.getByLabel(/^Name/).fill('Env Default Agent');
  await page.getByLabel(/^Mission/).fill('Use the server OpenRouter key by default.');
  await page.getByRole('button', { name: 'Create shadow agent' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link', { name: 'Env Default Agent', exact: true }).click();
  await openWorkspaceTab(page, 'Access');
  await openAccessSection(page, 'OpenRouter');

  await expect(
    page.getByRole('heading', { name: 'Using environment default', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Environment default', { exact: true })).toBeVisible();
  await expect(page.locator('#credential')).not.toContainText('test-only-env-default');
  await expect(page.getByText('OpenRouter environment default', { exact: true })).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await capturePage(page, `test-results/access-environment-Light-${width}.png`);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel('Agent API key', { exact: true }).fill('test-only-agent-override');
  await page.getByRole('button', { name: 'Save agent key', exact: true }).click();
  await expect(page.getByText('Credential saved encrypted.', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: "Using this agent's key", exact: true }),
  ).toBeVisible();
  await expect(page.locator('#credential')).not.toContainText('test-only-agent-override');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await capturePage(page, `test-results/access-agent-override-Light-${width}.png`);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Remove agent key', exact: true }).click();
  await expect(
    page.getByText('Credential removed. Simulations will use the environment default.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Using environment default', exact: true }),
  ).toBeVisible();
});
