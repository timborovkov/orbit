import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { expect, type Page, test } from '@playwright/test';
import postgres from 'postgres';

import { budgetDefaults } from '@/lib/budgets';
import { closeDb } from '@/lib/db';
import { claimJobs, completeJob } from '@/lib/queue/jobs';
import { processEmailSendJob } from '@/lib/runtime/email/send';
import { createStubEmailTransport } from '@/lib/runtime/email/transport';
import { EMAIL_SEND_JOB } from '@/lib/runtime/outbound/types';

import { openWorkspaceTab } from './workspace-nav';

const databaseUrl = 'postgres://orbit:orbit_dev@127.0.0.1:5432/orbit_test';
const sql = postgres(databaseUrl);
const admin = 'admin@example.com';
const workerId = 'outbound-email-screenshot-worker';

const ARTIFACT_DIRS = (() => {
  const dirs = [path.resolve('test-results/outbound-email-artifacts')];
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
  await sql`TRUNCATE person_relationship_notes, person_identity_changes, person_link_rejections, person_contacts, person_identities, people, evaluation_comparisons, evaluation_cases, agent_activity_events, follow_ups, outbound_actions, source_events, discovery_cursors, email_messages, email_threads, email_mailboxes, knowledge_chunks, knowledge_documents, knowledge_library_grants, knowledge_libraries, recipient_consents, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, agent_skills, agent_mcp_connections, skills, mcp_connections, sessions, agents, audit, login_attempts`;
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

async function seedLiveAgentWithDraft() {
  const agentId = randomUUID();
  const threadId = randomUUID();
  const messageId = randomUUID();
  const runId = randomUUID();
  const intentId = randomUUID();
  const [template] = await sql`SELECT config FROM templates WHERE id='support'`;
  const config = { ...template!.config, name: 'Outbound Screens' };
  await sql`INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES(${agentId},'Outbound Screens',${config.mission},'live',${sql.json(budgetDefaults)},'[]'::jsonb)`;
  const [version] = await sql`INSERT INTO agent_configurations(agent_id,version,config,actor)
    VALUES(${agentId},1,${sql.json(config)},${admin}) RETURNING id`;
  await sql`INSERT INTO email_mailboxes(agent_id,address,enabled)
    VALUES(${agentId},${`screens-${agentId.slice(0, 8)}@inbound.example.test`},true)`;
  const draft = 'Thanks — you can find invoices under Billing.';
  await sql`INSERT INTO email_threads(id,agent_id) VALUES(${threadId},${agentId})`;
  await sql`INSERT INTO simulation_runs(id,agent_id,configuration_id,input,actor,origin,status,result,expires_at,finished_at)
    VALUES(${runId},${agentId},${version!.id},'Invoice','fixture','email','completed',${sql.json({
      error: null,
      actions: [],
      steps: [
        {
          stage: 'main',
          model: 'fixture',
          inputTokens: 1,
          outputTokens: 1,
          decision: {
            relevant: true,
            priority: 1,
            reason: 'Billing',
            actions: [],
            answer: draft,
            citations: [],
          },
        },
      ],
    })},now(),now())`;
  await sql`INSERT INTO email_messages(
    id,agent_id,resend_email_id,event,sender,subject,received_at,configuration_id,run_id,thread_id,body,message_id
  ) VALUES(
    ${messageId},${agentId},${messageId},'{}'::jsonb,'customer@example.test','Invoice history',now(),${version!.id},${runId},${threadId},
    'Where are my invoices?','invoice-history@example.test'
  )`;
  await sql`INSERT INTO action_intents(
    id,agent_id,run_id,action_type,recipients,review_status,payload,idempotency_key,decision,reasons
  ) VALUES(
    ${intentId},${agentId},${runId},'email.send',${sql.json(['customer@example.test'])},'pending',
    ${sql.json({ draft, reason: 'Inbound email reply draft', emailMessageId: messageId, threadId })},
    ${`email.send:${messageId}`},'needs-approval',${sql.json(['An administrator must review this proposal.'])}
  )`;
  return { agentId, threadId, intentId };
}

test('review, approve, reject, and send outcome at desktop and mobile', async ({ page }) => {
  process.env.DATABASE_URL = databaseUrl;
  const pending = await seedLiveAgentWithDraft();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/agents/${pending.agentId}?tab=email&emailThread=${pending.threadId}`);
  await openWorkspaceTab(page, 'Email');
  await expect(page.getByRole('button', { name: 'Approve & queue' })).toBeVisible();
  await screenshotToArtifacts(page, 'email-reply-review-desktop-1440.png', { fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await screenshotToArtifacts(page, 'email-reply-review-mobile-390.png', { fullPage: true });

  // Reject path on a second agent/thread
  const rejected = await seedLiveAgentWithDraft();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/agents/${rejected.agentId}?tab=email&emailThread=${rejected.threadId}`);
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByRole('region', { name: 'Send outcome' })).toContainText('Rejected');
  await screenshotToArtifacts(page, 'email-reply-rejected-desktop-1440.png', { fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshotToArtifacts(page, 'email-reply-rejected-mobile-390.png', { fullPage: true });

  // Approve + stubbed worker send for outcome UI
  const approved = await seedLiveAgentWithDraft();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/agents/${approved.agentId}?tab=email&emailThread=${approved.threadId}`);
  const editedBody = 'Edited approved reply for screenshots.';
  const draft = page.getByLabel('Reply draft');
  await draft.fill(editedBody);
  await expect(draft).toHaveValue(editedBody);
  await page.getByRole('button', { name: 'Approve & queue' }).click();
  await expect(page.getByRole('region', { name: 'Send outcome' })).toContainText('Queued');
  const emailPanel = page.getByRole('tabpanel', { name: 'Email' });
  await expect(emailPanel.locator('.email-draft .preserve-text')).toHaveText(editedBody);
  await screenshotToArtifacts(page, 'email-reply-queued-desktop-1440.png', { fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshotToArtifacts(page, 'email-reply-queued-mobile-390.png', { fullPage: true });

  const transport = createStubEmailTransport();
  const claimed = await claimJobs({ workerId, limit: 5, types: [EMAIL_SEND_JOB] });
  expect(claimed).toHaveLength(1);
  for (const job of claimed) {
    await processEmailSendJob(job, new AbortController().signal, transport, {
      sendingDomain: 'inbound.example.test',
    });
    await completeJob(job.id, workerId);
  }
  expect(transport.calls.map(({ text }) => text)).toEqual([editedBody]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await openWorkspaceTab(page, 'Email');
  await expect(page.getByRole('region', { name: 'Send outcome' })).toContainText('Sent');
  await expect(
    page.getByRole('tabpanel', { name: 'Email' }).locator('.email-draft .preserve-text'),
  ).toHaveText(editedBody);
  await screenshotToArtifacts(page, 'email-reply-sent-desktop-1440.png', { fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshotToArtifacts(page, 'email-reply-sent-mobile-390.png', { fullPage: true });
});
