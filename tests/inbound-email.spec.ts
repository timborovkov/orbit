import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import postgres from 'postgres';

import { openWorkspaceTab } from './workspace-nav';

test('the admin can enable Sarah’s inbox and inspect a draft on mobile', async ({ page }) => {
  const sql = postgres('postgres://orbit:orbit_dev@localhost:5432/orbit_test');
  const agentId = randomUUID();
  const threadId = randomUUID();
  const subject = 'Invoice history fixture';
  try {
    await sql`TRUNCATE sessions, login_attempts`;
    await sql`INSERT INTO agents(id,name,mission,budgets) VALUES (${agentId},'Sarah','Answer email','{}'::jsonb)`;
    const [version] = await sql`INSERT INTO agent_configurations(agent_id,version,config,actor)
      SELECT ${agentId},1,config,'fixture' FROM templates WHERE id='support' RETURNING id`;

    const url = `/agents/${agentId}?tab=email`;
    await page.goto(url);
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel(/^Email/).fill('admin@example.com');
    await page.getByLabel(/^Password/).fill('test-only-password-123456');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();

    await page.goto(`/agents/${agentId}`);
    await openWorkspaceTab(page, 'Email');
    await expect(page.getByText('No email received yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Enable email' }).click();
    const address = page.locator('.email-address');
    await expect(address).toHaveText(/@inbound\.example\.test$/);
    const assigned = await address.innerText();
    await page.getByRole('button', { name: 'Disable email' }).click();
    await page.getByRole('button', { name: 'Enable email' }).click();
    await expect(address).toHaveText(assigned);

    const result = {
      error: null,
      actions: [],
      steps: [
        {
          stage: 'main',
          model: 'fixture/model',
          inputTokens: 2,
          outputTokens: 3,
          decision: {
            relevant: true,
            priority: 1,
            reason: 'Billing question',
            actions: [],
            answer: 'Open Billing to find your invoices.',
            citations: [1],
          },
        },
      ],
      knowledge: {
        status: 'allow',
        hits: [
          {
            sourceFilename: 'sarah-faq.md',
            section: 'Billing',
            content: 'Open Billing to view invoices.',
          },
        ],
      },
    };
    const [run] =
      await sql`INSERT INTO simulation_runs(agent_id,configuration_id,input,actor,origin,status,result,expires_at)
      VALUES(${agentId},${version!.id},'Invoice','fixture','email','completed',${sql.json(result)},now()) RETURNING id`;
    await sql`INSERT INTO email_threads(id,agent_id) VALUES (${threadId},${agentId})`;
    const messageId = randomUUID();
    await sql`INSERT INTO email_messages(id,agent_id,resend_email_id,event,sender,subject,received_at,run_id,thread_id,body)
      VALUES (${messageId},${agentId},${messageId},'{}','customer@example.test',${subject},now(),${run!.id},${threadId},'<img src=x>Where are my invoices?')`;
    const intentId = randomUUID();
    await sql`INSERT INTO action_intents(
      id,agent_id,run_id,action_type,recipients,review_status,payload,idempotency_key,decision,reasons
    ) VALUES (
      ${intentId},${agentId},${run!.id},'email.send',${sql.json(['customer@example.test'])},'pending',
      ${sql.json({
        draft: 'Open Billing to find your invoices.',
        emailMessageId: messageId,
        threadId,
      })},
      ${`email.send:${messageId}`},'needs-approval',${sql.json(['An administrator must review this proposal.'])}
    )`;

    await page.goto(url);
    await page.getByRole('link', { name: new RegExp(subject) }).click();
    await expect(page).toHaveURL(new RegExp(threadId));
    await expect(page.getByText('Awaiting approval')).toBeVisible();
    await expect(page.getByLabel('Reply draft')).toBeVisible();
    await expect(page.getByText(/sarah-faq.md/)).toBeVisible();
    await expect(
      page.getByText('<img src=x>Where are my invoices?', { exact: true }),
    ).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkspaceTab(page, 'Email');
    await expect(page.getByRole('button', { name: 'Approve & queue' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reject' })).toBeVisible();
    for (const mode of ['Light', 'Dark']) {
      await page.getByRole('radio', { name: mode, exact: true }).check();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
      const audit = await new AxeBuilder({ page })
        .include('.email-inbox')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(audit.violations).toEqual([]);
    }
  } finally {
    await sql`DELETE FROM evaluation_comparisons WHERE agent_id=${agentId}`;
    await sql`DELETE FROM evaluation_cases WHERE agent_id=${agentId}`;
    await sql`DELETE FROM outbound_actions WHERE agent_id=${agentId}`;
    await sql`DELETE FROM action_intents WHERE agent_id=${agentId}`;
    await sql`DELETE FROM email_messages WHERE agent_id=${agentId}`;
    await sql`DELETE FROM email_threads WHERE agent_id=${agentId}`;
    await sql`DELETE FROM simulation_runs WHERE agent_id=${agentId}`;
    await sql`DELETE FROM agent_configurations WHERE agent_id=${agentId}`;
    await sql`DELETE FROM agents WHERE id=${agentId}`;
    await sql.end();
  }
});
