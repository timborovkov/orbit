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

async function createAgent(page: Page, name: string) {
  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  await page.getByLabel(/^Name/).fill(name);
  await page.getByLabel(/^Mission/).fill('Operate within budgets and lifecycle controls.');
  await page.getByRole('button', { name: 'Create shadow agent' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
}

test.beforeEach(async () => {
  await sql`TRUNCATE recipient_consents, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, sessions, agents, audit, login_attempts`;
  await sql`UPDATE controls SET paused=true`;
});

test.afterAll(async () => {
  await sql.end();
});

test('lifecycle controls, budgets and run states on desktop and mobile', async ({ page }) => {
  test.setTimeout(120000);
  await signIn(page);
  await createAgent(page, 'Runtime');
  await page.getByRole('link', { name: 'Runtime' }).click();
  await expect(page.getByRole('heading', { name: 'Runtime', exact: true })).toBeVisible();
  await expect(page.getByText('Shadow', { exact: true }).first()).toBeVisible();

  await page.getByRole('tab', { name: 'Access' }).click();
  await expect(page.getByRole('heading', { name: 'Lifecycle', exact: true })).toBeVisible();
  await expect(
    page.getByText('no external action adapters exist yet', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Set Paused', exact: true }).click();
  // Lifecycle form unmounts on success (Current replaces the button), so assert durable UI.
  await expect(page.locator('.agent-name-line .state-label')).toContainText('Paused');
  await expect(page.locator('#lifecycle .lifecycle-option.selected h3')).toHaveText('Paused');

  await page.getByRole('button', { name: 'Set Live', exact: true }).click();
  await expect(page.locator('.agent-name-line .state-label')).toContainText('Live');
  await expect(page.locator('#lifecycle .lifecycle-option.selected h3')).toHaveText('Live');
  await expect(
    page.getByText('no external action adapters exist yet', { exact: false }),
  ).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Budgets', exact: true })).toBeVisible();
  await page.getByLabel('Max tool steps per run').fill('8');
  await page.getByRole('button', { name: 'Save budgets', exact: true }).click();
  await expect(page.getByText('Budgets saved.', { exact: false })).toBeVisible();

  await page.getByRole('tab', { name: 'Playground' }).click();
  await expect(page.getByLabel(/^Post or question/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'Access' }).click();
  await page.screenshot({
    path: 'test-results/runtime-access-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: 'test-results/runtime-access-mobile.png',
    fullPage: true,
  });

  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByRole('heading', { name: 'Run history', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: 'test-results/runtime-history-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: 'test-results/runtime-history-mobile.png',
    fullPage: true,
  });
});

test('administrators control independent spend caps, consent and proposal review', async ({
  page,
}) => {
  await signIn(page);
  await createAgent(page, 'Review Agent');
  await page.getByRole('link', { name: 'Review Agent' }).click();
  await page.getByRole('tab', { name: 'Access' }).click();
  const dailyCap = page.getByRole('checkbox', { name: /No cap for daily/ });
  await dailyCap.check();
  await page.getByLabel('Monthly OpenRouter spend cap (USD cents)', { exact: true }).fill('450');
  await page.getByRole('button', { name: 'Save budgets', exact: true }).click();
  await expect(page.getByText('Budgets saved.')).toBeVisible();
  const [agent] = await sql`SELECT id, budgets FROM agents WHERE name='Review Agent'`;
  expect(agent.budgets).toMatchObject({ dailySpendCents: null, monthlySpendCents: 450 });

  await page
    .getByLabel('Recipient ID', { exact: false })
    .filter({ visible: true })
    .fill('fixture-a');
  await page
    .getByLabel('Evidence reference', { exact: false })
    .fill('Synthetic conversation record');
  await page.getByRole('button', { name: 'Save consent', exact: true }).click();
  await expect(page.getByText('Consent recorded.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Recent consent records' })).toContainText('Granted');
  await page.getByLabel('Recipient decision').selectOption('revoke');
  await page.getByRole('button', { name: 'Save consent', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Recent consent records' })).toContainText('Revoked');

  await page.getByRole('checkbox', { name: 'Reply', exact: true }).check();
  await page.getByRole('button', { name: 'Save approval requirements', exact: true }).click();
  await expect(page.getByText('Approval requirements saved.')).toBeVisible();
  await sql`UPDATE controls SET paused=false`;
  await sql`
    INSERT INTO action_intents(agent_id, action_type, payload, idempotency_key, decision, review_status)
    VALUES
      (${agent.id}, 'reply', '{"draft": "First fixture"}', 'accept-fixture', 'needs-approval', 'pending'),
      (${agent.id}, 'reply', '{"draft": "Second fixture"}', 'reject-fixture', 'needs-approval', 'pending')
  `;

  await page.reload();
  await page.getByRole('tab', { name: /Approvals/ }).click();
  const proposals = page.getByRole('list', { name: 'Proposals, pending first' });
  const toApprove = proposals.getByRole('listitem').filter({ hasText: 'First fixture' });
  await toApprove.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(toApprove.getByText('approved', { exact: true })).toBeVisible();
  const toReject = proposals.getByRole('listitem').filter({ hasText: 'Second fixture' });
  await toReject.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(toReject.getByText('rejected', { exact: true })).toBeVisible();
});
