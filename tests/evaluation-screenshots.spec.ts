import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { expect, type Page, test } from '@playwright/test';
import postgres from 'postgres';

import { budgetDefaults } from '@/lib/budgets';
import { closeDb } from '@/lib/db';
import {
  processEvaluationReplayJob,
  saveEvaluationCase,
  startEvaluationComparison,
} from '@/lib/runtime/evaluation';
import { encryptCredential } from '@/lib/runtime/secrets';

import { capturePage } from './screenshot';

const databaseUrl = 'postgres://orbit:orbit_dev@127.0.0.1:5432/orbit_test';
process.env.DATABASE_URL = databaseUrl;
process.env.ORBIT_ENCRYPTION_KEY = 'a'.repeat(64);
const sql = postgres(databaseUrl);
const uncapped = { ...budgetDefaults, dailySpendCents: null, monthlySpendCents: null };

const ARTIFACT_DIRS = (() => {
  const dirs = [path.resolve('test-results/evaluation-artifacts')];
  const cursor = process.env.CURSOR_ARTIFACTS_DIR ?? '/opt/cursor/artifacts';
  try {
    mkdirSync(cursor, { recursive: true });
    dirs.push(cursor);
  } catch {
    // ignore
  }
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  return dirs;
})();

function artifactPath(name: string) {
  return path.join(ARTIFACT_DIRS[0], name);
}

async function scrollToTop(page: Page) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
}

async function screenshotToArtifacts(page: Page, name: string) {
  await scrollToTop(page);
  const primary = artifactPath(name);
  await capturePage(page, primary);
  for (const dir of ARTIFACT_DIRS.slice(1)) {
    copyFileSync(primary, path.join(dir, name));
  }
}

test.beforeEach(async ({ page }) => {
  await sql`TRUNCATE person_relationship_notes, person_identity_changes, person_link_rejections, person_contacts, person_identities, people, evaluation_comparisons, evaluation_cases, agent_activity_events, follow_ups, outbound_actions, source_events, discovery_cursors, email_messages, email_threads, email_mailboxes, knowledge_chunks, knowledge_documents, recipient_consents, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, agent_skills, agent_mcp_connections, skills, mcp_connections, sessions, agents, audit, login_attempts`;
  await sql`UPDATE controls SET paused=false`;
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

async function seedComparisonFixture() {
  const [agent] = await sql`
    INSERT INTO agents(name, mission, lifecycle, budgets, enabled_tools)
    VALUES ('Eval Screens', 'Compare configs', 'shadow', ${sql.json(uncapped)}, ${sql.json([])})
    RETURNING id
  `;
  const cfg = {
    name: 'Eval Screens',
    role: 'Sales',
    personality: 'Direct',
    mission: 'Compare configs',
    instructions: 'Be concise',
    engagementCriteria: 'B2B leads',
    mainModel: 'fixture/main',
    evaluatorModel: 'fixture/eval',
  };
  const [v1] = await sql`
    INSERT INTO agent_configurations(agent_id, version, config, actor)
    VALUES (${agent.id}, 1, ${sql.json(cfg)}, 'admin@example.com')
    RETURNING id, version
  `;
  const [v2] = await sql`
    INSERT INTO agent_configurations(agent_id, version, config, actor)
    VALUES (${agent.id}, 2, ${sql.json({ ...cfg, personality: 'Warmer' })}, 'admin@example.com')
    RETURNING id, version
  `;
  await sql`INSERT INTO agent_credentials VALUES (${agent.id}, ${encryptCredential(agent.id, 'secret')})`;

  const [run] = await sql`
    INSERT INTO simulation_runs(agent_id, configuration_id, origin, input, status, result, actor, expires_at, finished_at)
    VALUES (
      ${agent.id},
      ${v2.id},
      'playground',
      ${'Need a CRM that keeps follow-ups personal.'},
      'completed',
      ${sql.json({
        steps: [],
        actions: [
          {
            type: 'reply',
            draft: 'Happy to help.',
            reason: 'relevant',
            policy: 'suppressed',
            effect: 'Simulation only.',
          },
        ],
        error: null,
      })},
      'admin@example.com',
      now() + interval '1 hour',
      now()
    )
    RETURNING id, input
  `;

  return { agent, v1, v2, run };
}

for (const width of [1440, 390] as const) {
  test(`evaluation workflow screenshots at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    const { agent, v1, v2, run } = await seedComparisonFixture();

    await page.goto(`/agents/${agent.id}?run=${run.id}`);
    await expect(page.getByRole('heading', { name: 'Run history' })).toBeVisible();
    await expect(page.locator(`#run-${run.id}`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save as case' })).toBeVisible();
    // Ensure Save as case is laid out, then reset scroll so the sticky header is at the top.
    await page.getByRole('button', { name: 'Save as case' }).scrollIntoViewIfNeeded();
    await screenshotToArtifacts(page, `evaluation-save-case-${width}.png`);

    const saved = await saveEvaluationCase({
      actor: 'admin@example.com',
      agentId: agent.id,
      title: 'CRM lead post',
      sourceKind: 'playground',
      sourceRunId: run.id,
      caseInput: run.input,
      recipients: [],
    });
    expect('caseId' in saved).toBe(true);
    if (!('caseId' in saved)) return;

    await page.goto('/evaluations');
    await expect(page.getByRole('heading', { name: 'Evaluations' })).toBeVisible();
    await page.locator('select[name="caseId"]').selectOption({ label: 'CRM lead post' });
    await page.locator('select[name="leftConfigurationId"]').selectOption({ value: v1.id });
    await page.locator('select[name="rightConfigurationId"]').selectOption({ value: v2.id });
    if (width === 390) {
      const mobileCase = page.locator('.library-card-list .library-card', {
        has: page.locator('.library-primary', { hasText: 'CRM lead post' }),
      });
      await expect(mobileCase).toBeVisible();
      await expect(mobileCase.locator('.library-secondary')).toContainText(
        'Need a CRM that keeps follow-ups personal.',
      );
    } else {
      await expect(
        page.locator('.library-table .library-primary', { hasText: 'CRM lead post' }),
      ).toBeVisible();
    }
    await screenshotToArtifacts(page, `evaluation-choose-configs-${width}.png`);

    const started = await startEvaluationComparison({
      actor: 'admin@example.com',
      agentId: agent.id,
      caseId: saved.caseId,
      leftConfigurationId: v1.id,
      rightConfigurationId: v2.id,
    });
    expect('comparisonId' in started).toBe(true);
    if (!('comparisonId' in started)) return;

    await processEvaluationReplayJob(
      { comparisonId: started.comparisonId, agentId: agent.id, actor: 'admin@example.com' },
      () => async () => ({
        decision: {
          relevant: true,
          priority: 0.8,
          reason: 'sales lead',
          actions: [
            { type: 'reply', reason: 'offer help', draft: 'Happy to walk you through Orbit.' },
          ],
        },
        inputTokens: 10,
        outputTokens: 12,
      }),
    );

    await page.goto(`/evaluations/${started.comparisonId}`);
    await expect(page.getByRole('heading', { name: 'CRM lead post' })).toBeVisible();
    await expect(page.getByText('Shared input')).toBeVisible();
    await expect(page.getByText('Configuration A')).toBeVisible();
    await expect(page.getByText('Configuration B')).toBeVisible();
    await screenshotToArtifacts(page, `evaluation-side-by-side-${width}.png`);

    await page.goto(`/evaluations/${started.comparisonId}`);
    await expect(page.getByRole('heading', { name: 'CRM lead post' })).toBeVisible();
    await screenshotToArtifacts(page, `evaluation-reopen-${width}.png`);
  });
}
