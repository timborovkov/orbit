import { expect, test } from '@playwright/test';
import postgres from 'postgres';

const sql = postgres('postgres://orbit:orbit_dev@localhost:5432/orbit_test');
test.afterAll(async () => {
  await sql.end();
});

test('Access tab shows environment default and agent override without revealing key values', async ({
  page,
}) => {
  test.setTimeout(90000);
  await sql`TRUNCATE recipient_consents, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, sessions, agents, audit, login_attempts`;
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill('admin@example.com');
  await page.getByLabel(/^Password/).fill('test-only-password-123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  await page.getByLabel('Template', { exact: true }).selectOption({ label: 'Blank' });
  await page.getByLabel(/^Name/).fill('Env Default Agent');
  await page.getByLabel(/^Mission/).fill('Use the server OpenRouter key by default.');
  await page.getByRole('button', { name: 'Create shadow agent' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link', { name: 'Env Default Agent', exact: true }).click();
  await page.getByRole('tab', { name: 'Access', exact: true }).click();

  await expect(
    page.getByRole('heading', { name: 'Using environment default', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Environment default', { exact: true })).toBeVisible();
  await expect(page.locator('#credential')).not.toContainText('test-only-env-default');
  await expect(page.getByText('OpenRouter environment default', { exact: true })).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({
      path: `test-results/access-environment-Light-${width}.png`,
      fullPage: true,
    });
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
    await page.screenshot({
      path: `test-results/access-agent-override-Light-${width}.png`,
      fullPage: true,
    });
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
