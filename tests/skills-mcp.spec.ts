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

async function setTheme(page: Page, mode: 'light' | 'dark') {
  await page.getByRole('radio', { name: mode === 'dark' ? 'Dark' : 'Light', exact: true }).check();
  await page.emulateMedia({ colorScheme: mode });
}

async function shot(page: Page, name: string, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `test-results/${name}.png`, fullPage: true });
}

test.beforeEach(async () => {
  await sql`TRUNCATE recipient_consents, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, agent_skills, agent_mcp_connections, skills, mcp_connections, sessions, agents, audit, login_attempts`;
  await sql`UPDATE controls SET paused=true`;
});

test.afterAll(async () => {
  await sql.end();
});

test('skills and MCP library UI across empty, create, data and themes', async ({ page }) => {
  test.setTimeout(240000);
  await signIn(page);

  for (const mode of ['light', 'dark'] as const) {
    await setTheme(page, mode);

    await page.goto('/skills');
    await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No skills yet' })).toBeVisible();
    await expect(page.getByLabel('Breadcrumb').getByText('Skills', { exact: true })).toBeVisible();
    await shot(page, `skills-empty-desktop-${mode}`, { width: 1440, height: 900 });
    await shot(page, `skills-empty-mobile-${mode}`, { width: 390, height: 844 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Workspace navigation' }).click();
    await expect(page.getByRole('menuitem', { name: 'Skills' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'MCP' })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'New skill', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'New skill' })).toBeVisible();
    await shot(page, `skills-create-desktop-${mode}`, { width: 1440, height: 900 });
    await page.keyboard.press('Escape');

    await page.goto('/mcp');
    await expect(page.getByRole('heading', { name: 'MCP connections', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No MCP connections yet' })).toBeVisible();
    await expect(
      page.getByLabel('Breadcrumb').getByText('MCP connections', { exact: true }),
    ).toBeVisible();
    await shot(page, `mcp-empty-desktop-${mode}`, { width: 1440, height: 900 });
    await shot(page, `mcp-empty-mobile-${mode}`, { width: 390, height: 844 });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'New connection', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'New connection' })).toBeVisible();
    await shot(page, `mcp-create-desktop-${mode}`, { width: 1440, height: 900 });
    await page.keyboard.press('Escape');
  }

  await setTheme(page, 'light');
  await page.goto('/skills');
  await page.getByRole('button', { name: 'New skill', exact: true }).first().click();
  await page.getByLabel(/^Title/).fill('Research brief');
  await expect(page.getByLabel(/^Slug/)).toHaveValue('research-brief');
  await page.getByLabel(/^When to use/).fill('Use when drafting a research summary.');
  await page.getByRole('tab', { name: 'Write' }).click();
  await page
    .getByLabel(/^Markdown body/)
    .fill('# Research brief\n\nCollect sources first.\n\n- Note claims\n- Cite links');
  await page.getByRole('tab', { name: 'Preview' }).click();
  await expect(page.locator('.markdown-preview h1')).toContainText('Research brief');
  await page.getByRole('tab', { name: 'Write' }).click();
  await page.getByRole('button', { name: 'Create skill', exact: true }).click();
  await expect(page.getByText('Research brief').first()).toBeVisible();

  await page.goto('/mcp');
  await page.getByRole('button', { name: 'New connection', exact: true }).first().click();
  await page.getByLabel(/^Slug/).fill('docs-mcp');
  await page.getByLabel(/^URL/).fill('https://example.com/mcp');
  await page.getByRole('combobox', { name: /^Transport/ }).click();
  await page.getByRole('option', { name: 'HTTP', exact: true }).click();
  await page.getByLabel(/^Tool name/).fill('search');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove search' })).toBeVisible();
  await expect(page.getByLabel('Selected tools')).toContainText('search');
  await page.getByLabel(/Header 1 name/).fill('Authorization');
  await page.getByLabel(/Header 1 value/).fill('Bearer test-token');
  await page.getByRole('button', { name: 'Create connection', exact: true }).click();
  await expect(page.getByText('docs-mcp').first()).toBeVisible();

  await page.goto('/');
  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  await page.getByRole('combobox', { name: 'Template', exact: true }).click();
  await page.getByRole('option', { name: 'Customer Support', exact: true }).click();
  await page.getByLabel(/^Name/).fill('Support desk');
  await page.getByRole('button', { name: 'Create shadow agent' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link', { name: 'Support desk', exact: true }).click();
  await expect(page).toHaveURL(/\/agents\//);
  const agentUrl = page.url();

  for (const mode of ['light', 'dark'] as const) {
    await setTheme(page, mode);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/skills');
    await expect(
      page.locator('.library-table-wrap .library-primary', { hasText: 'Research brief' }),
    ).toBeVisible();
    await shot(page, `skills-list-desktop-${mode}`, { width: 1440, height: 900 });
    await shot(page, `skills-list-mobile-${mode}`, { width: 390, height: 844 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: /Edit Research brief/ }).click();
    await expect(page.getByRole('heading', { name: 'Edit skill' })).toBeVisible();
    await shot(page, `skills-edit-desktop-${mode}`, { width: 1440, height: 900 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `test-results/skills-edit-mobile-${mode}.png`, fullPage: true });
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/mcp');
    await expect(
      page.locator('.library-table-wrap .library-primary', { hasText: 'docs-mcp' }),
    ).toBeVisible();
    await shot(page, `mcp-list-desktop-${mode}`, { width: 1440, height: 900 });
    await shot(page, `mcp-list-mobile-${mode}`, { width: 390, height: 844 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: /Edit docs-mcp/ }).click();
    await expect(page.getByRole('heading', { name: 'Edit connection' })).toBeVisible();
    await expect(page.getByText('Clear stored headers')).toBeVisible();
    await shot(page, `mcp-edit-desktop-${mode}`, { width: 1440, height: 900 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: `test-results/mcp-edit-mobile-${mode}.png`,
      fullPage: true,
    });
    await page.keyboard.press('Escape');
  }

  for (const mode of ['light', 'dark'] as const) {
    await setTheme(page, mode);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(agentUrl);
    await page.getByRole('tab', { name: 'Access', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Access sections' })
      .getByRole('button', { name: 'Skills' })
      .click();
    await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible();
    await expect(page.getByText('Research brief').first()).toBeVisible();
    await shot(page, `access-skills-desktop-${mode}`, { width: 1440, height: 900 });
    await page
      .getByRole('navigation', { name: 'Access sections' })
      .getByRole('button', { name: 'MCP' })
      .click();
    await expect(page.getByRole('heading', { name: 'MCP connections', exact: true })).toBeVisible();
    await expect(page.getByText('docs-mcp').first()).toBeVisible();
    await shot(page, `access-mcp-desktop-${mode}`, { width: 1440, height: 900 });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel('Access section').click();
    await page.getByRole('option', { name: 'Skills', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible();
    await shot(page, `access-skills-mobile-${mode}`, { width: 390, height: 844 });
    await page.getByLabel('Access section').click();
    await page.getByRole('option', { name: 'MCP', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'MCP connections', exact: true })).toBeVisible();
    await shot(page, `access-mcp-mobile-${mode}`, { width: 390, height: 844 });
  }

  await setTheme(page, 'light');
  await page.goto('/skills');
  await shot(page, 'skills-desktop-1440x900', { width: 1440, height: 900 });
  await shot(page, 'skills-mobile-390x844', { width: 390, height: 844 });
  await page.goto('/mcp');
  await shot(page, 'mcp-desktop-1440x900', { width: 1440, height: 900 });
  await shot(page, 'mcp-mobile-390x844', { width: 390, height: 844 });
});
