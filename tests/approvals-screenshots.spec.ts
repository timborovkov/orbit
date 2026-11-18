import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

const sql = postgres('postgres://orbit:orbit_dev@127.0.0.1:5432/orbit_test');

/**
 * Turbopack is rooted at the monorepo (`next.config.ts`), so writing under the
 * repo (e.g. test-results/) during a live `next dev` remounts the app. Capture
 * outside the repo first, then mirror after the suite finishes.
 */
const LIVE_ARTIFACT_DIR = (() => {
  const preferred = process.env.CURSOR_ARTIFACTS_DIR ?? '/opt/cursor/artifacts';
  try {
    mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    const fallback = '/tmp/approvals-artifacts';
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
})();
const POST_RUN_ARTIFACT_DIR = path.resolve('test-results/approvals-artifacts');
const capturedNames: string[] = [];

function artifactPath(name: string) {
  return path.join(LIVE_ARTIFACT_DIR, name);
}

async function screenshotToArtifacts(
  page: Page,
  name: string,
  options?: Parameters<Page['screenshot']>[0],
) {
  const primary = artifactPath(name);
  await page.screenshot({ ...options, path: primary });
  capturedNames.push(name);
}

test.afterAll(async () => {
  try {
    mkdirSync(POST_RUN_ARTIFACT_DIR, { recursive: true });
    for (const name of capturedNames) {
      copyFileSync(path.join(LIVE_ARTIFACT_DIR, name), path.join(POST_RUN_ARTIFACT_DIR, name));
    }
  } catch {
    // CI without /opt still keeps /tmp captures; ignore mirror failures.
  }
  await sql.end();
});

test.beforeEach(async () => {
  await sql`TRUNCATE recipient_consents, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, sessions, agents, audit, login_attempts`;
  await sql`UPDATE controls SET paused=true`;
});

async function hideDevChrome(page: Page) {
  try {
    await page.addStyleTag({
      content:
        'nextjs-portal, [data-next-badge-root], [data-nextjs-toast], [data-nextjs-dev-overlay], #__next-build-watcher { display: none !important; }',
    });
  } catch {
    // Ignore when Turbopack remounts mid-injection.
  }
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((mode) => {
    localStorage.setItem('orbit-theme', mode);
    document.documentElement.dataset.theme = mode;
    window.dispatchEvent(new Event('orbit-theme-change'));
  }, theme);
}

async function preparePage(page: Page, theme: 'light' | 'dark') {
  await page.waitForLoadState('domcontentloaded');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await setTheme(page, theme);
      await hideDevChrome(page);
      return;
    } catch {
      await page.waitForLoadState('load');
    }
  }
  await setTheme(page, theme);
  await hideDevChrome(page);
}

/** Open Access → Approvals in the #24 AccessWorkbench (left nav or compact Select). */
async function openAccessApprovals(page: Page) {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30000 });
  const accessTab = page.getByRole('tab', { name: 'Access' });
  const compactWorkspace = page.getByLabel('Agent workspace section');
  // Wait for hydration: either desktop tabs or the ≤600px Select.
  await expect(accessTab.or(compactWorkspace)).toBeVisible({ timeout: 30000 });
  if (await accessTab.isVisible()) {
    await accessTab.click();
  } else {
    await compactWorkspace.click();
    await page.getByRole('option', { name: /^Access/ }).click();
  }
  const navButton = page.locator('.access-sections button', { hasText: 'Approvals' });
  const compactAccess = page.getByLabel('Access section', { exact: true });
  await expect(navButton.or(compactAccess).first()).toBeVisible({ timeout: 15000 });
  if (await navButton.isVisible()) {
    await navButton.click();
  } else {
    // ≤900px: AccessWorkbench collapses section nav to a Select.
    await compactAccess.click();
    await page.getByRole('option', { name: 'Approvals' }).click();
  }
  await expect(page.getByTestId('approval-settings')).toBeVisible({ timeout: 15000 });
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
  test.setTimeout(240000);
  const agent = await seedApprovals();

  for (const theme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/approvals', { waitUntil: 'load' });
    await preparePage(page, theme);
    await expect(page.getByTestId('approvals-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Approvals', exact: true })).toBeVisible();
    await screenshotToArtifacts(page, `approvals-pending-${theme}-desktop-1440x900.png`, {
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await hideDevChrome(page);
    await screenshotToArtifacts(page, `approvals-pending-${theme}-mobile-390x844.png`, {
      fullPage: true,
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('checkbox', { name: 'Select all pending approvals' }).click();
    await expect(page.getByText(/selected$/)).toBeVisible();
    // Scroll so the last pending card clears the fixed bulk bar, then shoot the viewport.
    await page.locator('.approvals-bulk-spacer').scrollIntoViewIfNeeded();
    await hideDevChrome(page);
    await screenshotToArtifacts(page, `approvals-bulk-${theme}-desktop-1440x900.png`, {
      fullPage: false,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.approvals-bulk-spacer').scrollIntoViewIfNeeded();
    await hideDevChrome(page);
    await screenshotToArtifacts(page, `approvals-bulk-${theme}-mobile-390x844.png`, {
      fullPage: false,
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/agents/${agent.id}`, { waitUntil: 'load' });
    await preparePage(page, theme);
    await openAccessApprovals(page);
    const approvalSettings = page.getByTestId('approval-settings');
    await approvalSettings.scrollIntoViewIfNeeded();
    const spend = page.locator('.approval-spend-field');
    await spend.scrollIntoViewIfNeeded();
    const spendBox = await spend.boundingBox();
    if (spendBox) {
      await screenshotToArtifacts(page, `spend-field-only-${theme}.png`, {
        clip: {
          x: Math.max(0, spendBox.x - 12),
          y: Math.max(0, spendBox.y - 40),
          width: Math.min(420, spendBox.width + 24),
          height: spendBox.height + 64,
        },
      });
      if (theme === 'light') {
        await screenshotToArtifacts(page, 'spend-field-only.png', {
          clip: {
            x: Math.max(0, spendBox.x - 12),
            y: Math.max(0, spendBox.y - 40),
            width: Math.min(420, spendBox.width + 24),
            height: spendBox.height + 64,
          },
        });
      }
    }
    // Capture the Access workbench with Approvals section active (nav + panel).
    await screenshotToArtifacts(page, `agent-approval-settings-${theme}-desktop-1440x900.png`, {
      fullPage: false,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await openAccessApprovals(page);
    await screenshotToArtifacts(page, `agent-approval-settings-${theme}-mobile-390x844.png`, {
      fullPage: false,
    });
  }

  await sql`DELETE FROM action_intents WHERE review_status = 'pending'`;
  for (const theme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/approvals', { waitUntil: 'load' });
    await preparePage(page, theme);
    await expect(page.getByTestId('approvals-empty')).toBeVisible();
    await screenshotToArtifacts(page, `approvals-empty-${theme}-desktop-1440x900.png`, {
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await hideDevChrome(page);
    await screenshotToArtifacts(page, `approvals-empty-${theme}-mobile-390x844.png`, {
      fullPage: true,
    });
  }

  // Keep canonical artifact names for the PR summary.
  await page.setViewportSize({ width: 1440, height: 900 });
  // Restore pending items for the canonical pending shot.
  await sql`
    INSERT INTO action_intents(agent_id, action_type, payload, idempotency_key, decision, review_status)
    VALUES
      (${agent.id}, 'reply', '{"draft": "Desktop draft", "reason": "Screenshot fixture"}', 'shot-canonical', 'needs-approval', 'pending')
  `;
  await page.goto('/approvals', { waitUntil: 'load' });
  await preparePage(page, 'light');
  await screenshotToArtifacts(page, 'approvals-page-desktop-1440x900.png', { fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await hideDevChrome(page);
  await screenshotToArtifacts(page, 'approvals-page-mobile-390x844.png', { fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/agents/${agent.id}`, { waitUntil: 'load' });
  await preparePage(page, 'light');
  await openAccessApprovals(page);
  await screenshotToArtifacts(page, 'agent-approval-settings-desktop-1440x900.png', {
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await openAccessApprovals(page);
  await screenshotToArtifacts(page, 'agent-approval-settings-mobile-390x844.png', {
    fullPage: false,
  });
});
