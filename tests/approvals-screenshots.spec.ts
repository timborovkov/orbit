import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

const sql = postgres('postgres://orbit:orbit_dev@127.0.0.1:5432/orbit_test');

test.beforeEach(async () => {
  await sql`TRUNCATE recipient_consents, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, sessions, agents, audit, login_attempts`;
  await sql`UPDATE controls SET paused=true`;
});

test.afterAll(async () => {
  await sql.end();
});

async function hideDevChrome(page: Page) {
  await page.addStyleTag({
    content:
      'nextjs-portal, [data-next-badge-root], [data-nextjs-toast], [data-nextjs-dev-overlay], #__next-build-watcher { display: none !important; }',
  });
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((mode) => {
    localStorage.setItem('orbit-theme', mode);
    document.documentElement.dataset.theme = mode;
  }, theme);
}

async function seedApprovals() {
  const agents = [];
  for (const name of ['Approval Screens', 'Second Agent']) {
    const [agent] = await sql`
      INSERT INTO agents(
        name, mission, lifecycle, budgets, enabled_tools, approval_tools, approval_on_reject
      )
      VALUES (
        ${name},
        'Capture approval UI screenshots.',
        'shadow',
        '{"dailySpendCents":null,"monthlySpendCents":null,"dailyRequests":1000,"monthlyRequests":10000,"dailyOutboundActions":100,"monthlyOutboundActions":1000,"maxConcurrentRuns":2,"maxToolStepsPerRun":8}'::jsonb,
        '[]'::jsonb,
        '["reply"]'::jsonb,
        'continue'
      )
      RETURNING id, name
    `;
    await sql`
      INSERT INTO agent_configurations(agent_id, version, config, actor)
      SELECT ${agent.id}, 1, config, 'local-admin@example.test' FROM templates WHERE id='support'
    `;
    agents.push(agent);
  }

  await sql`
    INSERT INTO action_intents(agent_id, action_type, payload, idempotency_key, decision, review_status)
    VALUES
      (${agents[0].id}, 'reply', '{"draft": "First draft", "reason": "Screenshot fixture"}', 'shot-pending-1', 'needs-approval', 'pending'),
      (${agents[0].id}, 'like', '{"draft": "Second draft", "reason": "Another pending item"}', 'shot-pending-2', 'needs-approval', 'pending'),
      (${agents[1].id}, 'repost', '{"draft": "Third draft", "reason": "Cross-agent pending"}', 'shot-pending-3', 'needs-approval', 'pending'),
      (${agents[0].id}, 'follow', '{"draft": null, "reason": "Approved history"}', 'shot-approved', 'suppressed', 'approved'),
      (${agents[0].id}, 'bookmark', '{"draft": null, "reason": "Rejected history"}', 'shot-rejected', 'suppressed', 'rejected')
  `;
  await sql`UPDATE action_intents SET reviewed_by='local-admin@example.test', reviewed_at=now() WHERE idempotency_key IN ('shot-approved', 'shot-rejected')`;
  return agents[0];
}

test('Approvals page and agent approval settings screenshots', async ({ page }) => {
  test.setTimeout(180000);
  const agent = await seedApprovals();

  for (const theme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/approvals', { waitUntil: 'networkidle' });
    await setTheme(page, theme);
    await hideDevChrome(page);
    await expect(page.getByTestId('approvals-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Approvals', exact: true })).toBeVisible();
    await page.screenshot({
      path: `/opt/cursor/artifacts/approvals-pending-${theme}-desktop-1440x900.png`,
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await hideDevChrome(page);
    await page.screenshot({
      path: `/opt/cursor/artifacts/approvals-pending-${theme}-mobile-390x844.png`,
      fullPage: true,
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      const boxes = document.querySelectorAll<HTMLButtonElement>(
        '[aria-label^="Select "][data-slot="checkbox"], .approvals-card-select button[role="checkbox"]',
      );
      for (const box of boxes) {
        if (box.getAttribute('aria-checked') !== 'true') box.click();
      }
    });
    await expect(page.getByText(/selected$/)).toBeVisible();
    await page.screenshot({
      path: `/opt/cursor/artifacts/approvals-bulk-${theme}-desktop-1440x900.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: `/opt/cursor/artifacts/approvals-bulk-${theme}-mobile-390x844.png`,
      fullPage: true,
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/agents/${agent.id}`, { waitUntil: 'networkidle' });
    await setTheme(page, theme);
    await hideDevChrome(page);
    await page.getByRole('tab', { name: 'Access' }).click();
    const approvalSettings = page.getByTestId('approval-settings');
    await expect(approvalSettings).toBeVisible();
    await approvalSettings.scrollIntoViewIfNeeded();
    const box = await approvalSettings.boundingBox();
    await page.screenshot({
      path: `/opt/cursor/artifacts/agent-approval-settings-${theme}-desktop-1440x900.png`,
      clip: box
        ? {
            x: Math.max(0, box.x - 32),
            y: Math.max(0, box.y - 24),
            width: Math.min(1400, box.width + 64),
            height: Math.min(900, box.height + 48),
          }
        : undefined,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await approvalSettings.scrollIntoViewIfNeeded();
    const mobileBox = await approvalSettings.boundingBox();
    await page.screenshot({
      path: `/opt/cursor/artifacts/agent-approval-settings-${theme}-mobile-390x844.png`,
      clip: mobileBox
        ? {
            x: Math.max(0, mobileBox.x - 8),
            y: Math.max(0, mobileBox.y - 8),
            width: Math.min(390, mobileBox.width + 16),
            height: Math.min(1400, mobileBox.height + 16),
          }
        : undefined,
    });
  }

  await sql`DELETE FROM action_intents WHERE review_status = 'pending'`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/approvals', { waitUntil: 'networkidle' });
  await setTheme(page, 'light');
  await hideDevChrome(page);
  await expect(page.getByTestId('approvals-empty')).toBeVisible();
  await page.screenshot({
    path: '/opt/cursor/artifacts/approvals-empty-light-desktop-1440x900.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: '/opt/cursor/artifacts/approvals-empty-light-mobile-390x844.png',
    fullPage: true,
  });

  // Keep canonical artifact names for the PR summary.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/approvals', { waitUntil: 'networkidle' });
  await setTheme(page, 'light');
  await hideDevChrome(page);
  // Restore pending items for the canonical pending shot.
  await sql`
    INSERT INTO action_intents(agent_id, action_type, payload, idempotency_key, decision, review_status)
    VALUES
      (${agent.id}, 'reply', '{"draft": "Desktop draft", "reason": "Screenshot fixture"}', 'shot-canonical', 'needs-approval', 'pending')
  `;
  await page.reload({ waitUntil: 'networkidle' });
  await hideDevChrome(page);
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
  await page.goto(`/agents/${agent.id}`, { waitUntil: 'networkidle' });
  await setTheme(page, 'light');
  await hideDevChrome(page);
  await page.getByRole('tab', { name: 'Access' }).click();
  const settings = page.getByTestId('approval-settings');
  await settings.scrollIntoViewIfNeeded();
  const settingsBox = await settings.boundingBox();
  await page.screenshot({
    path: '/opt/cursor/artifacts/agent-approval-settings-desktop-1440x900.png',
    clip: settingsBox
      ? {
          x: Math.max(0, settingsBox.x - 32),
          y: Math.max(0, settingsBox.y - 24),
          width: Math.min(1400, settingsBox.width + 64),
          height: Math.min(900, settingsBox.height + 48),
        }
      : undefined,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await settings.scrollIntoViewIfNeeded();
  const settingsMobile = await settings.boundingBox();
  await page.screenshot({
    path: '/opt/cursor/artifacts/agent-approval-settings-mobile-390x844.png',
    clip: settingsMobile
      ? {
          x: Math.max(0, settingsMobile.x - 8),
          y: Math.max(0, settingsMobile.y - 8),
          width: Math.min(390, settingsMobile.width + 16),
          height: Math.min(1400, settingsMobile.height + 16),
        }
      : undefined,
  });
});
