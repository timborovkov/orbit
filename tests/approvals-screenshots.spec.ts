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

async function hideDevChrome(page: import('@playwright/test').Page) {
  await page.addStyleTag({
    content:
      'nextjs-portal, [data-next-badge-root], [data-nextjs-toast], [data-nextjs-dev-overlay], #__next-build-watcher { display: none !important; }',
  });
}

test('Approvals page and agent approval settings screenshots', async ({ page }) => {
  test.setTimeout(120000);

  const [agent] = await sql`
    INSERT INTO agents(
      name, mission, lifecycle, budgets, enabled_tools, approval_tools, approval_on_reject
    )
    VALUES (
      'Approval Screens',
      'Capture approval UI screenshots.',
      'shadow',
      '{"dailySpendCents":null,"monthlySpendCents":null,"dailyRequests":1000,"monthlyRequests":10000,"dailyOutboundActions":100,"monthlyOutboundActions":1000,"maxConcurrentRuns":2,"maxToolStepsPerRun":8}'::jsonb,
      '[]'::jsonb,
      '["reply"]'::jsonb,
      'continue'
    )
    RETURNING id
  `;
  await sql`
    INSERT INTO agent_configurations(agent_id, version, config, actor)
    SELECT ${agent.id}, 1, config, 'local-admin@example.test' FROM templates WHERE id='support'
  `;
  await sql`
    INSERT INTO action_intents(agent_id, action_type, payload, idempotency_key, decision, review_status)
    VALUES
      (${agent.id}, 'reply', '{"draft": "Desktop draft", "reason": "Screenshot fixture"}', 'shot-pending', 'needs-approval', 'pending'),
      (${agent.id}, 'like', '{"draft": null, "reason": "History fixture"}', 'shot-done', 'suppressed', 'approved')
  `;
  await sql`UPDATE action_intents SET reviewed_by='local-admin@example.test', reviewed_at=now() WHERE idempotency_key='shot-done'`;

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/approvals', { waitUntil: 'networkidle' });
  await hideDevChrome(page);
  await expect(page.getByTestId('approvals-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Approvals', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const box = document.querySelector<HTMLInputElement>('.approvals-row-select input');
    if (box && !box.checked) {
      box.click();
    }
  });
  await page.screenshot({
    path: '/opt/cursor/artifacts/approvals-page-desktop-1440x900.png',
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await hideDevChrome(page);
  await page.screenshot({
    path: '/opt/cursor/artifacts/approvals-page-mobile-390x844.png',
    fullPage: true,
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/agents/${agent.id}`, { waitUntil: 'networkidle' });
  await hideDevChrome(page);
  await page.getByRole('tab', { name: 'Access' }).click();
  const approvalSettings = page.getByTestId('approval-settings');
  await expect(approvalSettings).toBeVisible();
  await approvalSettings.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const desktopBox = await approvalSettings.boundingBox();
  await page.screenshot({
    path: '/opt/cursor/artifacts/agent-approval-settings-desktop-1440x900.png',
    clip: desktopBox
      ? {
          x: Math.max(0, desktopBox.x - 32),
          y: Math.max(0, desktopBox.y - 24),
          width: Math.min(1400, desktopBox.width + 64),
          height: Math.min(860, desktopBox.height + 48),
        }
      : undefined,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await approvalSettings.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const mobileBox = await approvalSettings.boundingBox();
  await page.screenshot({
    path: '/opt/cursor/artifacts/agent-approval-settings-mobile-390x844.png',
    clip: mobileBox
      ? {
          x: Math.max(0, mobileBox.x - 8),
          y: Math.max(0, mobileBox.y - 8),
          width: Math.min(390, mobileBox.width + 16),
          height: Math.min(1200, mobileBox.height + 16),
        }
      : undefined,
  });
});
