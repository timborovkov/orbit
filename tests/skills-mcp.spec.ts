import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, type Page, test } from '@playwright/test';
import postgres from 'postgres';

import { mcpFixtureAuthorization, startMcpFixture } from './fixtures/mcp-server';
import { openAccessSection, openWorkspaceTab } from './workspace-nav';

const databaseUrl = 'postgres://orbit:orbit_dev@localhost:5432/orbit_test';
const sql = postgres(databaseUrl);
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
  await sql`TRUNCATE agent_memories, person_relationship_notes, person_identity_changes, person_link_rejections, person_contacts, person_identities, people, evaluation_comparisons, evaluation_cases, agent_activity_events, follow_ups, outbound_actions, source_events, discovery_cursors, email_messages, email_threads, email_mailboxes, knowledge_chunks, knowledge_documents, knowledge_library_grants, knowledge_libraries, recipient_consents, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, agent_skills, agent_mcp_connections, skills, mcp_connections, sessions, agents, audit, login_attempts`;
  await sql`UPDATE controls SET paused=true`;
});

test.afterAll(async () => {
  await sql.end();
});

test('saved Skills and authenticated MCP grants reach the worker and run history', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const fixture = await startMcpFixture();
  try {
    await signIn(page);
    await page.goto('/skills');
    await page.getByRole('button', { name: 'New skill', exact: true }).click();
    await page.getByLabel(/^Title/).fill('Release check');
    await page.getByLabel(/^When to use/).fill('Check the release fixture.');
    await page.getByLabel(/^Markdown body/).fill('# Release check\nVerify both connections.');
    await page.getByRole('button', { name: 'Create skill', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.goto('/mcp');
    for (const transport of ['http', 'sse'] as const) {
      const slug = `${transport}-fixture`;
      const tool = `${transport}_lookup`;
      await page.getByRole('button', { name: 'New connection', exact: true }).click();
      await page.getByLabel(/^Slug/).fill(slug);
      await page.getByLabel(/^URL/).fill(`${fixture.url}/${transport}`);
      await page.getByRole('combobox', { name: /^Transport/ }).click();
      await page.getByRole('option', { name: transport.toUpperCase(), exact: true }).click();
      await page.getByLabel(/Header 1 name/).fill('Authorization');
      await page.getByLabel(/Header 1 value/).fill(mcpFixtureAuthorization);
      await page.getByRole('button', { name: 'Fetch tools' }).click();
      await page.getByRole('button', { name: `Add ${tool}` }).click();
      await page.getByRole('button', { name: new RegExp(`${tool} effect: Mutating`) }).click();
      await page.getByRole('button', { name: 'Create connection', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeHidden();
    }

    await page.getByRole('button', { name: /Edit http-fixture/ }).click();
    await page.getByRole('button', { name: 'Fetch tools' }).click();
    await expect(page.getByRole('button', { name: 'Fetch tools' })).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByLabel(/^URL/).fill(`${fixture.url}/different`);
    await page.getByRole('button', { name: 'Fetch tools' }).click();
    await expect(page.getByRole('alert')).toContainText('Replace or clear stored headers');
    await page.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Replace or clear stored headers' }),
    ).toHaveCount(2);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.goto('/');
    await page.getByRole('button', { name: 'Create agent', exact: true }).click();
    await page.getByRole('combobox', { name: 'Template', exact: true }).click();
    await page.getByRole('option', { name: 'Customer Support', exact: true }).click();
    await page.getByLabel(/^Name/).fill('Resource fixture agent');
    await page.getByRole('button', { name: 'Create shadow agent' }).click();
    await page.getByRole('link', { name: 'Resource fixture agent', exact: true }).click();
    await openWorkspaceTab(page, 'Access');
    await openAccessSection(page, 'Skills');
    await page.getByRole('checkbox', { name: 'Release check' }).check();
    await page.getByRole('button', { name: 'Save skill selection' }).click();
    await expect(page.getByText('Attached 1 skill.')).toBeVisible();
    await openAccessSection(page, 'MCP');
    for (const transport of ['http', 'sse'] as const) {
      await page.getByRole('checkbox', { name: `${transport}-fixture` }).check();
      const grant = page.getByRole('checkbox', { name: `${transport}_lookup` });
      await expect(grant).not.toBeChecked();
      await grant.check();
    }
    await page.getByRole('button', { name: 'Save MCP selection' }).click();
    await expect(page.getByText('Attached 2 MCP connections.')).toBeVisible();

    await page.reload();
    await openWorkspaceTab(page, 'Access');
    await openAccessSection(page, 'Skills');
    await expect(page.getByRole('checkbox', { name: 'Release check' })).toBeChecked();
    await openAccessSection(page, 'MCP');
    await expect(page.getByRole('checkbox', { name: 'http_lookup' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'sse_lookup' })).toBeChecked();

    const [agent] = await sql`SELECT id FROM agents WHERE name='Resource fixture agent'`;
    await sql`UPDATE agents SET budgets=budgets || '{"dailySpendCents":null,"monthlySpendCents":null}'::jsonb WHERE id=${agent.id}`;
    // Give the real worker runtime a dedicated fixture run so the default worker cannot claim it.
    const [run] =
      await sql`INSERT INTO simulation_runs(agent_id,configuration_id,input,status,result,actor,expires_at)
      SELECT ${agent.id}, id, 'Check fixture resources', 'queued', '{"steps":[],"actions":[],"error":null}'::jsonb,
        ${email}, now() + interval '5 minutes' FROM agent_configurations WHERE agent_id=${agent.id} RETURNING id`;
    await promisify(execFile)(
      'bun',
      ['--no-env-file', require.resolve('./fixtures/run-resource-simulation.ts'), run.id],
      {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          OPENROUTER_API_KEY: 'local-model-fixture',
          ORBIT_ENCRYPTION_KEY: 'a'.repeat(64),
        },
      },
    );
    const [completed] = await sql`SELECT status,result FROM simulation_runs WHERE id=${run.id}`;
    expect(completed.status, completed.result.error).toBe('completed');
    expect(completed.result.providerDispatches).toEqual({ evaluator: 1, main: 2 });
    expect(fixture.calls.toSorted()).toEqual(['http_lookup', 'sse_lookup']);

    await page.reload();
    await openWorkspaceTab(page, /^History/);
    await page.locator('#history .run-detail > summary').click();
    const history = page.getByRole('region', { name: 'Skills and tools' });
    await expect(history).toContainText('release-check · v1 · loaded');
    await expect(history).toContainText('mcp:http-fixture:http_lookup · allow');
    await expect(history).toContainText('mcp:sse-fixture:sse_lookup · allow');

    await page.goto('/mcp');
    await page.getByRole('button', { name: /Edit http-fixture/ }).click();
    await page.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.getByRole('button', { name: /Edit http-fixture/ }).click();
    await page.getByLabel(/^URL/).fill(`${fixture.url}/different`);
    await page.getByRole('switch', { name: 'Clear stored headers' }).check();
    await page.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    const grants = await sql`SELECT m.name, a.tool_names FROM agent_mcp_connections a
      JOIN mcp_connections m ON m.id=a.connection_id WHERE a.agent_id=${agent.id} ORDER BY m.name`;
    expect(grants).toEqual([
      { name: 'http-fixture', tool_names: [] },
      { name: 'sse-fixture', tool_names: ['sse_lookup'] },
    ]);
  } finally {
    fixture.close();
  }
});

test('skills and MCP library UI across empty, create, data and themes', async ({ page }) => {
  test.setTimeout(240000);
  await signIn(page);

  for (const mode of ['light', 'dark'] as const) {
    await setTheme(page, mode);

    await page.goto('/skills');
    await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No skills yet' })).toBeVisible();
    await shot(page, `skills-empty-desktop-${mode}`, { width: 1440, height: 900 });
    await shot(page, `skills-empty-mobile-${mode}`, { width: 390, height: 844 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Workspace navigation' }).click();
    await expect(page.getByRole('menuitem', { name: 'Skills' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('menuitem', { name: 'MCP' })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'New skill', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New skill' })).toBeVisible();
    await shot(page, `skills-create-desktop-${mode}`, { width: 1440, height: 900 });
    await page.keyboard.press('Escape');

    await page.goto('/mcp');
    await expect(page.getByRole('heading', { name: 'MCP connections', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No MCP connections yet' })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'MCP' }),
    ).toHaveAttribute('aria-current', 'page');
    await shot(page, `mcp-empty-desktop-${mode}`, { width: 1440, height: 900 });
    await shot(page, `mcp-empty-mobile-${mode}`, { width: 390, height: 844 });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'New connection', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New connection' })).toBeVisible();
    await shot(page, `mcp-create-desktop-${mode}`, { width: 1440, height: 900 });
    await page.keyboard.press('Escape');
  }

  await setTheme(page, 'light');
  await page.goto('/skills');
  await page.getByRole('button', { name: 'New skill', exact: true }).click();
  await page.getByLabel(/^Title/).fill('Research brief');
  await expect(page.getByLabel(/^Slug/)).toHaveValue('research-brief');
  await page.getByLabel(/^When to use/).fill('Use when drafting a research summary.');
  const body = page.getByLabel(/^Markdown body/);
  const preview = page.getByRole('tab', { name: 'Preview', exact: true });
  await preview.click();
  await page.getByRole('button', { name: 'Create skill', exact: true }).click();
  await expect(body).toBeFocused();
  await body.fill('Collect sources first.');
  await body.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(body).toHaveValue('**Collect sources first.**');
  await body.press('ControlOrMeta+z');
  await expect(body).toHaveValue('Collect sources first.');
  const markdown =
    '# Research brief\n\n- Note claims\n- Cite links\n\n| Source | Status |\n| --- | --- |\n| Reports | Reviewed |';
  await body.fill(markdown);
  await page.getByRole('tab', { name: 'Split', exact: true }).click();
  await expect(body).toBeVisible();
  await expect(page.locator('.markdown-preview h1')).toHaveText('Research brief');
  await expect(
    page.locator('.markdown-preview').getByRole('cell', { name: 'Reviewed' }),
  ).toBeVisible();
  await preview.click();
  await page.getByRole('button', { name: 'Create skill', exact: true }).click();
  await expect(page.getByText('Research brief').first()).toBeVisible();
  await page.getByRole('button', { name: /Edit Research brief/ }).click();
  await expect(body).toHaveValue(markdown);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /Edit Research brief/ })).toBeFocused();

  await page.goto('/mcp');
  await page.getByRole('button', { name: 'New connection', exact: true }).click();
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
