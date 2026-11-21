import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { expect, type Page, test } from '@playwright/test';
import postgres from 'postgres';

import { closeDb } from '@/lib/db';
import { startJobWorker } from '@/lib/queue/worker';
import { processSimulationJob, SIMULATION_JOB_TYPE } from '@/lib/runtime/execute';

import { openAccessSection, openWorkspaceTab } from './workspace-nav';

const databaseUrl = 'postgres://orbit:orbit_dev@127.0.0.1:5432/orbit_test';
const sql = postgres(databaseUrl);

/** Runner-writable output; also mirror into Cursor artifacts when that path exists. */
const ARTIFACT_DIRS = (() => {
  const dirs = [path.resolve('test-results/approvals-artifacts')];
  const cursor = process.env.CURSOR_ARTIFACTS_DIR ?? '/opt/cursor/artifacts';
  try {
    mkdirSync(cursor, { recursive: true });
    dirs.push(cursor);
  } catch {
    // GitHub runners cannot write under /opt; keep the repo-relative dir only.
  }
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  return dirs;
})();

function artifactPath(name: string) {
  return path.join(ARTIFACT_DIRS[0], name);
}

async function screenshotToArtifacts(
  page: Page,
  name: string,
  options?: Parameters<Page['screenshot']>[0],
) {
  const primary = artifactPath(name);
  await page.screenshot({ ...options, path: primary });
  for (const dir of ARTIFACT_DIRS.slice(1)) {
    copyFileSync(primary, path.join(dir, name));
  }
}

test.beforeEach(async ({ page }) => {
  await sql`TRUNCATE person_relationship_notes, person_identity_changes, person_link_rejections, person_contacts, person_identities, people, evaluation_comparisons, evaluation_cases, agent_activity_events, follow_ups, outbound_actions, source_events, discovery_cursors, email_messages, email_threads, email_mailboxes, knowledge_chunks, knowledge_documents, recipient_consents, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, agent_skills, agent_mcp_connections, skills, mcp_connections, sessions, agents, audit, login_attempts`;
  await sql`UPDATE controls SET paused=true`;
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill('admin@example.com');
  await page.getByLabel(/^Password/).fill('test-only-password-123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
});

test.afterAll(async () => {
  await closeDb();
  await sql.end();
});

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((mode) => {
    localStorage.setItem('orbit-theme', mode);
    document.documentElement.dataset.theme = mode;
    window.dispatchEvent(new Event('orbit-theme-change'));
  }, theme);
}

async function preparePage(page: Page, theme: 'light' | 'dark') {
  await expect(page.locator('body')).toBeVisible();
  await setTheme(page, theme);
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

async function openAccessApprovals(page: Page) {
  await openWorkspaceTab(page, 'Access');
  await openAccessSection(page, 'Approvals');
  await expect(page.getByTestId('approval-settings')).toBeVisible();
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
    await screenshotToArtifacts(page, `approvals-pending-${theme}-mobile-390x844.png`, {
      fullPage: true,
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('checkbox', { name: 'Select all pending approvals' }).click();
    await expect(page.getByText(/selected$/)).toBeVisible();
    // Scroll so the last pending card clears the fixed bulk bar, then shoot the viewport.
    await page.locator('.approvals-bulk-spacer').scrollIntoViewIfNeeded();
    await screenshotToArtifacts(page, `approvals-bulk-${theme}-desktop-1440x900.png`, {
      fullPage: false,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.approvals-bulk-spacer').scrollIntoViewIfNeeded();
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

test('Playground sends a suspended run to Approvals and resumes with no repeat inference', async ({
  page,
}) => {
  const agent = await seedApprovals();
  await sql`DELETE FROM action_intents`;
  await sql`UPDATE controls SET paused=false`;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  process.env.DATABASE_URL = databaseUrl;
  process.env.OPENROUTER_API_KEY = 'playwright-approval-fixture';
  let modelCalls = 0;
  const workerId = 'playwright-approval-worker';
  const startWorker = () =>
    startJobWorker({
      workerId,
      pollMs: 40,
      leaseMs: 5000,
      handlers: {
        [SIMULATION_JOB_TYPE]: async (job, signal) => {
          await processSimulationJob(
            job.payload,
            () => async () => {
              modelCalls++;
              return {
                decision: {
                  relevant: true,
                  priority: 0.6,
                  reason: 'Playwright review fixture',
                  actions: [
                    { type: 'reply', reason: 'Review this reply', draft: 'Original draft' },
                  ],
                },
                inputTokens: 3,
                outputTokens: 2,
              };
            },
            signal,
            { jobId: job.id, workerId },
          );
        },
      },
    });

  let worker = startWorker();

  try {
    await page.goto(`/agents/${agent.id}`);
    await openWorkspaceTab(page, 'Playground');
    await page.getByRole('button', { name: 'Recipients for consent checks' }).click();
    await page.getByLabel('Recipient ID', { exact: true }).fill('browser-recipient');
    await page.getByRole('textbox', { name: 'Post or question' }).fill('Please review my reply');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(
      page.getByText('Awaiting approval', { exact: false }).filter({ visible: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).not.toBeVisible();
    const [waiting] = await sql`
      SELECT r.id, r.job_id, j.status AS job_status, j.claim_expires_at
      FROM simulation_runs r JOIN jobs j ON j.id=r.job_id
      WHERE r.agent_id=${agent.id} AND r.status='awaiting_approval'
    `;
    expect(waiting.job_status).toBe('completed');
    expect(waiting.claim_expires_at).toBeNull();
    expect(modelCalls).toBe(2);
    await worker.stop();

    await page.getByRole('link', { name: 'Review proposals' }).click();
    await expect(page).toHaveURL(new RegExp(`run=${waiting.id}$`));
    const pending = page.getByRole('list', { name: 'Pending approvals' });
    await expect(pending).toContainText('browser-recipient');
    await pending.getByRole('button', { name: 'Edit', exact: true }).click();
    await pending.getByRole('textbox', { name: 'Draft' }).fill('Approved in the browser');
    await pending.getByRole('button', { name: 'Save & approve' }).click();

    const history = page.getByRole('list', { name: 'Resolved approvals' });
    await expect(history).toContainText('Approved in the browser');
    const [queued] = await sql`SELECT status FROM simulation_runs WHERE id=${waiting.id}`;
    expect(queued.status).toBe('queued');
    worker = startWorker();
    await history.getByRole('link', { name: 'View originating run' }).click();
    const run = page.locator(`#run-${waiting.id}`);
    await expect(run.locator('.state-label').first()).toHaveText('completed');
    await expect(run).toContainText('Approved in the browser');
    const [completed] =
      await sql`SELECT job_id, result FROM simulation_runs WHERE id=${waiting.id}`;
    expect(completed.job_id).not.toBe(waiting.job_id);
    expect(completed.result.steps).toHaveLength(2);
    expect(modelCalls).toBe(2);
  } finally {
    await worker.stop();
    if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

test('bulk limits and agent filters clear discarded edits without a hydration error', async ({
  page,
}) => {
  const agent = await seedApprovals();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.setFixedTime(new Date(Date.now() + 3 * 86_400_000));
  await page.goto('/approvals');
  const reply = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('checkbox', { name: 'Select Reply for Approval Screens' }) });
  await reply.getByRole('checkbox').check();
  await reply.getByRole('button', { name: 'Edit', exact: true }).click();
  await reply.getByRole('textbox', { name: 'Draft' }).fill('Unsaved text');
  await expect(page.getByRole('button', { name: 'Bulk approve' })).toBeDisabled();

  const filters = page.getByRole('combobox', { name: 'Filter by agent' });
  await filters.click();
  await page.getByRole('option', { name: 'Second Agent' }).click();
  await expect(reply).toHaveCount(0);
  await filters.click();
  await page.getByRole('option', { name: 'All agents' }).click();
  await reply.getByRole('checkbox').check();
  await expect(page.getByRole('button', { name: 'Bulk approve' })).toBeEnabled();

  await sql`
    INSERT INTO action_intents(agent_id, action_type, payload, idempotency_key, decision, review_status)
    SELECT ${agent.id}, 'reply', '{}', 'batch-fixture-' || n, 'needs-approval', 'pending'
    FROM generate_series(1,51) AS s(n)
  `;
  await page.reload();
  await page.getByRole('checkbox', { name: 'Select up to 50 pending approvals' }).check();
  await expect(page.getByText('50 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Bulk reject' }).click();
  await expect(page.getByText('50 proposals rejected.')).toBeVisible();
  expect(errors).toEqual([]);
});
