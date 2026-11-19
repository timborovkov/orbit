import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

import { capturePage } from './screenshot';
import { openAccessSection, openWorkspaceTab } from './workspace-nav';

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
  await sql`TRUNCATE email_messages, email_threads, email_mailboxes, knowledge_chunks, knowledge_documents, recipient_consents, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, agent_skills, agent_mcp_connections, skills, mcp_connections, sessions, agents, audit, login_attempts`;
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

  await openWorkspaceTab(page, 'Access');
  await openAccessSection(page, 'Lifecycle');
  await expect(page.getByRole('heading', { name: 'Lifecycle', exact: true })).toBeVisible();
  await expect(
    page.getByText('no external action adapters exist yet', { exact: false }),
  ).toBeVisible();
  const lifecycle = page.getByRole('list', { name: 'Agent lifecycle' });
  const pause = lifecycle.getByRole('button', { name: 'Set Paused', exact: true });
  await pause.focus();
  await expect(pause).toBeFocused();
  await page.keyboard.press('Enter');
  // Lifecycle form unmounts on success (Current replaces the button), so assert durable UI.
  await expect(page.locator('.agent-name-line .state-label')).toContainText('Paused');
  await expect(page.locator('#lifecycle .lifecycle-card.is-selected h3')).toHaveText('Paused');

  await page.getByRole('button', { name: 'Set Live', exact: true }).click();
  await expect(page.locator('.agent-name-line .state-label')).toContainText('Live');
  await expect(page.locator('#lifecycle .lifecycle-card.is-selected h3')).toHaveText('Live');
  await expect(
    page.getByText('no external action adapters exist yet', { exact: false }),
  ).toBeVisible();

  await openAccessSection(page, 'Budgets');
  await expect(page.getByRole('heading', { name: 'Budgets', exact: true })).toBeVisible();
  await page.getByLabel('Max tool steps', { exact: true }).fill('8');
  await page.getByRole('button', { name: 'Save budgets', exact: true }).click();
  await expect(page.getByText('Budgets saved.', { exact: false })).toBeVisible();

  await openWorkspaceTab(page, 'Playground');
  await expect(page.getByLabel(/^Post or question/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspaceTab(page, 'Access');
  await capturePage(page, 'test-results/runtime-access-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await capturePage(page, 'test-results/runtime-access-mobile.png');

  await openWorkspaceTab(page, 'History');
  await expect(page.getByRole('heading', { name: 'Run history', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await capturePage(page, 'test-results/runtime-history-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await capturePage(page, 'test-results/runtime-history-mobile.png');
});

test('administrators control independent spend caps, consent and proposal review', async ({
  page,
}) => {
  await signIn(page);
  await createAgent(page, 'Review Agent');
  await page.getByRole('link', { name: 'Review Agent' }).click();
  await openWorkspaceTab(page, 'Access');
  await openAccessSection(page, 'Budgets');
  const dailyCap = page.getByRole('switch', { name: /No cap for daily/ });
  await dailyCap.click();
  await expect(dailyCap).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel('Monthly spend', { exact: true }).fill('450');
  await page.getByRole('button', { name: 'Save budgets', exact: true }).click();
  await expect(page.getByText('Budgets saved.')).toBeVisible();
  const [agent] = await sql`SELECT id, budgets FROM agents WHERE name='Review Agent'`;
  expect(agent.budgets).toMatchObject({ dailySpendCents: null, monthlySpendCents: 450 });

  await openAccessSection(page, 'Consent');
  const introductionConsent = page.getByRole('checkbox', { name: 'Introductions', exact: true });
  await expect(introductionConsent).toBeChecked();
  await introductionConsent.uncheck();
  await page.getByRole('button', { name: 'Save consent requirements', exact: true }).click();
  await expect(page.getByText('Consent requirements saved.')).toBeVisible();
  const [consentPolicy] = await sql`SELECT consent_required_tools FROM agents WHERE id=${agent.id}`;
  expect(consentPolicy.consent_required_tools).toEqual(['escalate']);
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
  await page.getByLabel('Recipient decision').click();
  await page.getByRole('option', { name: 'Revoke', exact: true }).click();
  await page.getByRole('button', { name: 'Save consent', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Recent consent records' })).toContainText('Revoked');

  await openAccessSection(page, 'Approvals');
  const replyApproval = page.getByRole('switch', { name: 'Reply', exact: true });
  await replyApproval.click();
  await expect(replyApproval).toHaveAttribute('aria-checked', 'true');
  const introduceApproval = page.getByRole('switch', { name: 'Introduce', exact: true });
  await expect(introduceApproval).toHaveAttribute('aria-checked', 'false');
  await introduceApproval.click();
  await expect(page.getByRole('switch', { name: 'Escalate', exact: true })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.getByRole('button', { name: 'Save approval requirements', exact: true }).click();
  await expect(page.getByText('Approval requirements saved.')).toBeVisible();
  const [approvalPolicy] = await sql`SELECT approval_tools FROM agents WHERE id=${agent.id}`;
  expect(approvalPolicy.approval_tools).toEqual(['reply', 'introduce']);
  await sql`UPDATE controls SET paused=false`;
  await sql`
    INSERT INTO action_intents(agent_id, action_type, payload, idempotency_key, decision, review_status)
    VALUES
      (${agent.id}, 'reply', '{"draft": "First fixture"}', 'accept-fixture', 'needs-approval', 'pending'),
      (${agent.id}, 'reply', '{"draft": "Second fixture"}', 'reject-fixture', 'needs-approval', 'pending')
  `;

  await page.reload();
  await openWorkspaceTab(page, /Approvals/);
  const proposals = page.getByRole('list', { name: 'Proposals, pending first' });
  const toApprove = proposals.getByRole('listitem').filter({ hasText: 'First fixture' });
  await toApprove.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(toApprove.getByText('approved', { exact: true })).toBeVisible();
  const toReject = proposals.getByRole('listitem').filter({ hasText: 'Second fixture' });
  await toReject.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(toReject.getByText('rejected', { exact: true })).toBeVisible();
});
