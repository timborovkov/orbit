import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import postgres from 'postgres';

const sql = postgres('postgres://orbit:orbit_dev@localhost:5432/orbit_test');
test.afterAll(async () => {
  await sql.end();
});
test('template copies, independent versions, encrypted keys and durable manual run history', async ({
  page,
}) => {
  test.setTimeout(120000);
  await sql`TRUNCATE recipient_consents, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, sessions, agents, audit, login_attempts`;
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill('admin@example.com');
  await page.getByLabel(/^Password/).fill('test-only-password-123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  for (const [name, template] of [
    ['John', 'Sales and GTM'],
    ['Sarah', 'Customer Support'],
  ]) {
    await page.getByRole('button', { name: 'Create agent', exact: true }).click();
    await page.getByLabel('Template', { exact: true }).click();
    await page.getByRole('option', { name: template, exact: true }).click();
    await page.getByLabel(/^Name/).fill(name);
    await expect(page.getByLabel(/^Mission/)).not.toHaveValue('');
    await page.getByRole('button', { name: 'Create shadow agent' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  }
  await page.getByRole('link', { name: 'John', exact: true }).click();
  await expect(page).toHaveURL(/\/agents\//);
  const staleTab = await page.context().newPage();

  await staleTab.goto(page.url());
  await expect(page.getByLabel('Role', { exact: true })).toHaveValue('Sales representative');
  await page
    .getByLabel('Personality', { exact: true })
    .fill('Direct, energetic, and always concise.');
  await page.getByRole('tab', { name: 'Playground', exact: true }).click();
  await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
  await expect(page.getByLabel('Personality', { exact: true })).toHaveValue(
    'Direct, energetic, and always concise.',
  );
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
  await expect(page.getByText('Configuration v2', { exact: false })).toBeVisible();
  await staleTab.getByLabel('Personality', { exact: true }).fill('Unsaved stale edit');
  await staleTab.getByRole('button', { name: 'Save configuration', exact: true }).click();
  await expect(staleTab.locator('#configuration').getByRole('alert')).toContainText(
    'changed in another tab',
  );
  await expect(staleTab.getByLabel('Personality', { exact: true })).toHaveValue(
    'Unsaved stale edit',
  );
  await staleTab.close();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'Configuration', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Playground', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('A safe place to try things')).toBeVisible();
  for (const mode of ['Light', 'Dark']) {
    await page.getByRole('radio', { name: mode, exact: true }).check();
    await page.screenshot({
      path: `test-results/agent-Playground-empty-${mode}.png`,
      fullPage: true,
    });
  }
  await page.getByRole('radio', { name: 'Light', exact: true }).check();
  await page.getByRole('tab', { name: 'Access', exact: true }).click();
  await page.getByRole('button', { name: 'OpenRouter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No key available', exact: true })).toBeVisible();
  await expect(page.getByText('Not connected', { exact: true })).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({
      path: `test-results/access-none-Light-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel('Agent API key', { exact: true }).fill('test-only-secret-never-use');
  await page.getByRole('button', { name: 'Save agent key', exact: true }).click();
  await expect(page.getByText('Credential saved encrypted.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Agent API key', { exact: true })).toHaveValue('');
  await expect(
    page.getByRole('heading', { name: "Using this agent's key", exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Agent key', { exact: true })).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({
      path: `test-results/access-agent-Light-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const [john] =
    await sql`SELECT a.id,c.encrypted_key FROM agents a JOIN agent_credentials c ON c.agent_id=a.id WHERE a.name='John'`;
  expect(john.encrypted_key).not.toContain('test-only-secret');
  await page.getByRole('button', { name: 'Remove agent key', exact: true }).click();
  await expect(page.getByText('Credential removed.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No key available', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Playground', exact: true }).click();
  const input = 'Can you help me with product setup and choosing a plan?';
  const version2 = (
    await sql`SELECT id FROM agent_configurations WHERE agent_id=${john.id} AND version=2`
  )[0].id;
  await expect(page.getByLabel('Configuration version')).toContainText('Version 2 · John');
  expect(version2).toBeTruthy();
  await page.getByLabel('Configuration version').click();
  await page.getByRole('option', { name: 'Version 1 · John', exact: true }).click();
  await page.getByRole('tab', { name: 'Playground', exact: true }).click();
  await page.getByLabel(/^Post or question/).fill(input);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('Simulation queued', { exact: false })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByLabel('Configuration version')).toContainText('Version 1 · John');
  await page.getByRole('tab', { name: /^History/ }).click();
  await expect
    .poll(async () => page.locator('#history .state-label').first().textContent(), {
      timeout: 30000,
    })
    .toMatch(/failed|completed|interrupted/);
  await page.locator('.run-detail > summary').click();
  await expect(
    page.locator('#history').getByText('No OpenRouter credential available.', { exact: false }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('.run-detail > summary').click();
  await expect(
    page.locator('.run-content').filter({ visible: true }).getByText(input, { exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await expect(page.getByLabel(/^Main model/)).toHaveValue('deepseek/deepseek-v4.1-flash-1017');
  await expect(page.getByLabel(/^Evaluator model/)).toHaveValue(
    'deepseek/deepseek-v4.1-flash-1017',
  );
  await page.getByRole('button', { name: 'Identity', exact: true }).click();
  for (const mode of ['Light', 'Dark']) {
    await page.getByRole('radio', { name: mode, exact: true }).check();
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      if ([1440, 390].includes(width)) {
        await page.screenshot({ path: `test-results/agent-${mode}-${width}.png`, fullPage: true });
        for (const section of ['Behaviour', 'Models']) {
          await page.getByRole('button', { name: section, exact: true }).click();
          await page.screenshot({
            path: `test-results/agent-${section}-${mode}-${width}.png`,
            fullPage: true,
          });
        }
        await page.getByRole('button', { name: 'Identity', exact: true }).click();
        for (const tab of ['Playground', 'History', 'Access']) {
          await page.getByRole('tab', { name: new RegExp('^' + tab) }).click();
          if (tab === 'Access') {
            await page.getByRole('button', { name: 'OpenRouter', exact: true }).click();
          }
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          expect(
            (
              await new AxeBuilder({ page })
                .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
                .analyze()
            ).violations,
          ).toEqual([]);
          await page.screenshot({
            path: `test-results/agent-${tab}-${mode}-${width}.png`,
            fullPage: true,
          });
        }
        await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
      }
    }
  }
  await page.getByRole('link', { name: 'All agents', exact: false }).click();
  await page.getByRole('link', { name: 'Sarah', exact: true }).click();
  await expect(page.getByLabel('Role', { exact: true })).toHaveValue('Customer support specialist');
  await expect(page.getByLabel('Personality', { exact: true })).toHaveValue(
    'Patient, empathetic and precise.',
  );
  await page.getByRole('tab', { name: 'Playground', exact: true }).click();
  await page.getByLabel(/^Post or question/).fill(input);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('Simulation queued', { exact: false })).toBeVisible({
    timeout: 15000,
  });
  const versions =
    await sql`SELECT a.name,c.version,c.config FROM agents a JOIN agent_configurations c ON c.agent_id=a.id ORDER BY a.name,c.version`;
  expect(versions.map((v) => `${v.name}:${v.version}`)).toEqual(['John:1', 'John:2', 'Sarah:1']);
  await expect
    .poll(async () => {
      const rows =
        await sql`SELECT r.input,r.status,c.version FROM simulation_runs r JOIN agent_configurations c ON c.id=r.configuration_id`;
      return rows.length === 2 && rows.every((r) => r.input === input && r.status === 'failed');
    })
    .toBe(true);
  await page.getByRole('link', { name: 'All agents', exact: false }).click();
  await page.getByRole('link', { name: 'Templates', exact: true }).click();
  const support = page
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: 'Customer Support' }) });
  await support.locator('summary').click();
  const [originalTemplate] = await sql`SELECT revision FROM templates WHERE id='support'`;
  const original = await support.getByLabel('Personality', { exact: true }).inputValue();
  for (const mode of ['Light', 'Dark']) {
    await page.getByRole('radio', { name: mode, exact: true }).check();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({
        path: `test-results/templates-${mode}-${width}.png`,
        fullPage: true,
      });
    }
  }

  try {
    await support.getByLabel('Personality', { exact: true }).fill('New template voice');
    await support.getByRole('button', { name: 'Save template defaults' }).click();
    await expect(support.locator('summary')).toContainText(
      `Revision ${originalTemplate.revision + 1}`,
    );
    const [sarah] =
      await sql`SELECT c.config FROM agent_configurations c JOIN agents a ON a.id=c.agent_id WHERE a.name='Sarah'`;
    expect(sarah.config.personality).toBe(original);
  } finally {
    await sql`UPDATE templates SET config=jsonb_set(config,'{personality}',to_jsonb(${original}::text)),revision=${originalTemplate.revision} WHERE id='support'`;
  }
});
