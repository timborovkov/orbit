import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

const sql = postgres('postgres://orbit:orbit_dev@localhost:5432/orbit_test');
const email = 'admin@example.com';
const password = 'test-only-password-123456';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
}

test.beforeEach(async () => {
  await sql`TRUNCATE recipient_consents, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, agent_skills, agent_mcp_connections, skills, mcp_connections, sessions, agents, audit, login_attempts`;
  await sql`UPDATE controls SET paused=true`;
});

test.afterAll(async () => {
  await sql.end();
});

test('skills and MCP pages render at desktop and mobile', async ({ page }) => {
  test.setTimeout(120000);
  await signIn(page);

  await page.goto('/skills');
  await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: 'test-results/skills-desktop-1440x900.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: 'test-results/skills-mobile-390x844.png',
    fullPage: true,
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mcp');
  await expect(page.getByRole('heading', { name: 'MCP connections', exact: true })).toBeVisible();
  await page.screenshot({
    path: 'test-results/mcp-desktop-1440x900.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: 'test-results/mcp-mobile-390x844.png',
    fullPage: true,
  });
});
