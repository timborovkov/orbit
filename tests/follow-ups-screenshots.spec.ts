import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

import { closeDb } from '@/lib/db';
import { startJobWorker } from '@/lib/queue/worker';
import { FOLLOW_UP_JOB_TYPE, processFollowUpJob } from '@/lib/runtime/follow-ups/process';

import { openWorkspaceTab } from './workspace-nav';

const databaseUrl = 'postgres://orbit:orbit_dev@127.0.0.1:5432/orbit_test';
const sql = postgres(databaseUrl);

const ARTIFACT_DIRS = (() => {
  const dirs = [path.resolve('test-results/follow-ups-artifacts')];
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
  await sql`
    TRUNCATE agent_activity_events, follow_ups, email_messages, email_threads, email_mailboxes,
      knowledge_chunks, knowledge_documents, recipient_consents, policy_decisions, action_intents,
      usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations,
      agent_skills, agent_mcp_connections, skills, mcp_connections, sessions, agents, audit,
      login_attempts
  `;
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

async function createAgent(page: Page, name: string) {
  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  await page.getByLabel(/^Name/).fill(name);
  await page.getByLabel(/^Mission/).fill('Follow-up screenshot mission.');
  await page.getByRole('button', { name: 'Create shadow agent' }).click();
  await page.getByRole('link', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 15000 });
  const tabs = page.getByRole('tablist', { name: 'Agent workspace' });
  const section = page.getByRole('combobox', { name: 'Agent workspace section', exact: true });
  await expect(tabs.or(section).first()).toBeVisible({ timeout: 15000 });
}

function dueLocalInMinutes(minutes: number) {
  const date = new Date(Date.now() + minutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function scheduleFollowUp(page: Page, subject: string, minutesAhead = 120) {
  await openWorkspaceTab(page, 'Follow-ups');
  await expect(page.getByRole('heading', { name: 'Schedule a follow-up' })).toBeVisible();
  await page.getByLabel(/^Subject/).fill(subject);
  await page.getByLabel(/^Due/).fill(dueLocalInMinutes(minutesAhead));
  await page.getByLabel(/^Note/).fill('Screenshot note — internal only.');
  await page.getByRole('button', { name: 'Schedule follow-up', exact: true }).click();
  await expect(page.getByText(subject, { exact: true }).first()).toBeVisible({ timeout: 15000 });
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const) {
  test.describe(`follow-ups ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`schedule, inspect, cancel, and activity (${viewport.name})`, async ({ page }) => {
      await setTheme(page, 'light');
      await createAgent(page, `Follow-ups ${viewport.name}`);

      await scheduleFollowUp(page, 'Confirm demo booking');
      await screenshotToArtifacts(page, `follow-ups-schedule-${viewport.name}.png`, {
        fullPage: true,
      });

      const row = page.locator('.follow-up-detail', { hasText: 'Confirm demo booking' });
      await row.locator('summary').click();
      await expect(row.getByText('admin@example.com')).toBeVisible();
      await screenshotToArtifacts(page, `follow-ups-inspect-${viewport.name}.png`, {
        fullPage: true,
      });

      await row.getByRole('button', { name: 'Cancel follow-up', exact: true }).click();
      await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible({
        timeout: 15000,
      });
      await screenshotToArtifacts(page, `follow-ups-cancelled-${viewport.name}.png`, {
        fullPage: true,
      });

      // Schedule an immediately due follow-up and process it for the activity outcome.
      await scheduleFollowUp(page, 'Immediate internal check', -1);
      const [pending] = await sql`
        SELECT id FROM follow_ups
        WHERE subject='Immediate internal check' AND status='scheduled'
        ORDER BY created_at DESC LIMIT 1
      `;
      expect(pending?.id).toBeTruthy();

      // e2e.yml does not export DATABASE_URL into the Playwright process; set it
      // before starting the in-process worker (same pattern as approvals-screenshots).
      const originalDatabaseUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = databaseUrl;
      const worker = startJobWorker({
        workerId: `follow-ups-shot-${viewport.name}`,
        handlers: {
          [FOLLOW_UP_JOB_TYPE]: async (job) => {
            await processFollowUpJob(job.payload, job.attempts);
          },
        },
        pollMs: 50,
        recoveryMs: 5_000,
        leaseMs: 10_000,
      });
      try {
        for (let i = 0; i < 40; i++) {
          const [rowState] = await sql`SELECT status FROM follow_ups WHERE id=${pending!.id}`;
          if (rowState?.status === 'completed') break;
          await page.waitForTimeout(100);
        }
      } finally {
        await worker.stop();
        if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = originalDatabaseUrl;
      }

      await openWorkspaceTab(page, 'History');
      await expect(
        page.getByText('Follow-up completed: Immediate internal check', { exact: true }),
      ).toBeVisible({ timeout: 15000 });
      await screenshotToArtifacts(page, `follow-ups-activity-${viewport.name}.png`, {
        fullPage: true,
      });
    });
  });
}
