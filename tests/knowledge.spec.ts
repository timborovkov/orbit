import { expect, test } from '@playwright/test';
import postgres from 'postgres';

import { openWorkspaceTab } from './workspace-nav';

test('an admin can index, inspect and enable an agent’s knowledge library', async ({ page }) => {
  const sql = postgres('postgres://orbit:orbit_dev@localhost:5432/orbit_test');
  try {
    await sql`TRUNCATE knowledge_chunks, knowledge_documents, recipient_consents, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, sessions, agents, audit, login_attempts`;
  } finally {
    await sql.end();
  }
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill('admin@example.com');
  await page.getByLabel(/^Password/).fill('test-only-password-123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  await page.getByLabel(/^Name/).fill('Knowledge browser test');
  await page.getByLabel(/^Mission/).fill('Answer questions using the library.');
  await page.getByRole('button', { name: 'Create shadow agent' }).click();
  await page.getByRole('link', { name: 'Knowledge browser test' }).click();

  await openWorkspaceTab(page, 'Knowledge');
  const toggle = page.getByRole('button', { name: 'Use knowledge in Playground' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  const library = page.getByRole('region', { name: 'Knowledge library' });
  const file = {
    name: 'billing.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Billing\nThe invoice due date is December 7.'),
  };
  await library.locator('input[type=file]').first().setInputFiles(file);
  const item = library.getByRole('listitem').filter({ hasText: 'billing' });
  await expect(item.getByText('Ready', { exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole('textbox', { name: 'Query' }).fill('invoice due date');
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  const inspector = page.getByRole('region', { name: 'Retrieval inspector' });
  await expect(inspector.getByText(/December 7/).first()).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspaceTab(page, 'Playground');
  await openWorkspaceTab(page, 'Knowledge');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await item.getByRole('button', { name: 'Actions for billing' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(item).toHaveCount(0);
  await expect(inspector.getByText(/December 7/)).toHaveCount(0);
});
