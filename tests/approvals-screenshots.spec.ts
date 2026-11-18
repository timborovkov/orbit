import { expect, test } from '@playwright/test';
import postgres from 'postgres';

const sql = postgres('postgres://orbit:orbit_dev@127.0.0.1:5432/orbit_test');

test.beforeEach(async () => {
  await sql`TRUNCATE recipient_consents, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, sessions, agents, audit, login_attempts`;
  await sql`UPDATE controls SET paused=true`;
});

test.afterAll(async () => {
  await sql.end();
});

test('Approvals page and agent approval settings screenshots', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  await page.getByLabel(/^Name/).fill('Approval Screens');
  await page.getByLabel(/^Mission/).fill('Capture approval UI screenshots.');
  await page.getByRole('button', { name: 'Create shadow agent' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link', { name: 'Approval Screens' }).click();

  await page.getByRole('tab', { name: 'Access' }).click();
  await expect(page.getByTestId('approval-settings')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Reply', exact: true }).check();
  await page.getByRole('button', { name: 'Save approval requirements', exact: true }).click();
  await expect(page.getByText('Approval requirements saved.')).toBeVisible();

  const [agent] = await sql`SELECT id FROM agents WHERE name='Approval Screens'`;
  await sql`
    INSERT INTO action_intents(agent_id, action_type, payload, idempotency_key, decision, review_status)
    VALUES
      (${agent.id}, 'reply', '{"draft": "Desktop draft", "reason": "Screenshot fixture"}', 'shot-pending', 'needs-approval', 'pending'),
      (${agent.id}, 'like', '{"draft": null, "reason": "History fixture"}', 'shot-done', 'suppressed', 'approved')
  `;
  await sql`UPDATE action_intents SET reviewed_by='local-admin@example.test', reviewed_at=now() WHERE idempotency_key='shot-done'`;

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/approvals');
  await expect(page.getByTestId('approvals-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Approvals', exact: true })).toBeVisible();
  await page.screenshot({
    path: '/opt/cursor/artifacts/approvals-page-desktop-1440x900.png',
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: '/opt/cursor/artifacts/approvals-page-mobile-390x844.png',
    fullPage: true,
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/agents/${agent.id}`);
  await page.getByRole('tab', { name: 'Access' }).click();
  await expect(page.getByTestId('approval-settings')).toBeVisible();
  await page.screenshot({
    path: '/opt/cursor/artifacts/agent-approval-settings-desktop-1440x900.png',
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: '/opt/cursor/artifacts/agent-approval-settings-mobile-390x844.png',
    fullPage: true,
  });
});
