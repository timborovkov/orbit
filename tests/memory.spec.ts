import { randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import postgres from 'postgres';

import { openWorkspaceTab } from './workspace-nav';

test('admins can trace, correct, expire and remove an agent memory', async ({ page }) => {
  const sql = postgres('postgres://orbit:orbit_dev@localhost:5432/orbit_test');
  const sarah = randomUUID();
  const john = randomUUID();
  const memoryId = randomUUID();
  const threadId = randomUUID();
  const messageId = randomUUID();
  const fact = 'Northstar requires SSO for its pilot.';
  const corrected = 'Northstar requires SAML SSO for its pilot.';
  const message = `${fact}\n<em>Please confirm compatibility.</em>`;
  try {
    await sql`TRUNCATE sessions, login_attempts`;
    for (const [agentId, name] of [
      [sarah, 'Sarah'],
      [john, 'John'],
    ]) {
      await sql`INSERT INTO agents(id,name,mission,budgets) VALUES (${agentId},${name},'Support pilot onboarding','{}')`;
      await sql`INSERT INTO agent_configurations(agent_id,version,config,actor)
        SELECT ${agentId},1,config,'fixture' FROM templates WHERE id='support'`;
    }
    const [run] =
      await sql`INSERT INTO simulation_runs(agent_id,configuration_id,input,actor,origin,status,result,expires_at)
      SELECT ${sarah},id,${message},'fixture','email','completed','{"error":null,"actions":[],"steps":[]}',now()
      FROM agent_configurations WHERE agent_id=${sarah} RETURNING id`;
    await sql`INSERT INTO email_threads(id,agent_id) VALUES (${threadId},${sarah})`;
    await sql`INSERT INTO email_messages(id,agent_id,resend_email_id,event,sender,subject,received_at,run_id,thread_id,body)
      VALUES (${messageId},${sarah},${messageId},'{}','pilot@northstar.example.test','Pilot requirements',
        now(),${run!.id},${threadId},${message})`;
    const [memory] = await sql`INSERT INTO agent_memories
      (id,agent_id,subject_kind,subject,topic,identity_key,fact,quote,run_id,source_kind,source_id,source_at)
      VALUES(${memoryId},${sarah},'company','Northstar','SSO requirement','northstar-sso',${fact},
        ${fact},${run!.id},'email',${messageId},now()) RETURNING revision`;
    await sql`INSERT INTO simulation_runs(agent_id,configuration_id,input,actor,status,result,expires_at)
      SELECT ${sarah},id,'Does Northstar require SSO?','fixture','completed',${sql.json({
        error: null,
        actions: [],
        memory: [{ id: memoryId, revision: memory!.revision }],
        steps: [
          {
            stage: 'main',
            model: 'fixture/model',
            inputTokens: 5,
            outputTokens: 3,
            decision: {
              relevant: true,
              priority: 0.5,
              reason: '',
              actions: [],
              answer: fact,
              citations: [],
              memoryCitations: [1],
            },
          },
        ],
      })},now() FROM agent_configurations WHERE agent_id=${sarah}`;

    const evidence = `/agents/${sarah}/memory/${memoryId}/evidence?revision=${memory!.revision}`;
    await page.goto(evidence);
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel(/^Email/).fill('admin@example.com');
    await page.getByLabel(/^Password/).fill('test-only-password-123456');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/agents/${sarah}`);
    await openWorkspaceTab(page, 'Memory');
    const row = page.locator('.memory-detail');
    await expect(row.locator('summary')).toContainText(fact);
    await row.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(row.getByRole('link', { name: 'View original source' })).toBeVisible();
    await row.getByRole('link', { name: 'View original source' }).click();
    await expect(page.getByRole('heading', { name: 'Original inbound message' })).toBeVisible();
    await expect(page.getByText('<em>Please confirm compatibility.</em>')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open email thread' })).toHaveAttribute(
      'href',
      `/agents/${sarah}?tab=email&emailThread=${threadId}&emailMessage=${messageId}#message-${messageId}`,
    );

    await page.goto(evidence.replace(sarah, john));
    await expect(
      page.getByRole('heading', { name: 'This page could not be found.' }),
    ).toBeVisible();
    await expect(page.getByText(fact)).toHaveCount(0);
    await page.goto(`/agents/${john}?tab=memory`);
    await expect(page.getByText(/No memories yet/)).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`/agents/${sarah}`);
    await expect(page.getByRole('combobox', { name: 'Agent workspace section' })).toBeVisible();
    await openWorkspaceTab(page, 'History');
    await page
      .getByRole('tabpanel')
      .locator('summary', { hasText: 'Does Northstar require SSO?' })
      .click();
    await expect(page.getByRole('link', { name: 'Memory evidence 1' })).toHaveAttribute(
      'href',
      evidence,
    );
    await openWorkspaceTab(page, 'Memory');
    await row.locator('summary').click();
    await row.getByLabel('Fact or note').fill(corrected);
    await row.getByLabel('Expires on (UTC)').fill('2000-01-01');
    await row.getByRole('button', { name: 'Save correction' }).click();
    await expect(row.locator('summary')).toContainText(corrected);
    await expect(row.locator('summary')).toContainText('Expired');
    for (const width of [320, 768, 1024, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width);
    }
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);

    const remove = row.getByRole('button', { name: 'Remove memory' });
    await remove.click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(remove).toBeFocused();
    await remove.click();
    await dialog.getByRole('button', { name: 'Remove memory' }).click();
    await expect(page.getByText(/No memories yet/)).toBeVisible();
    expect(await sql`SELECT id FROM email_messages WHERE id=${messageId}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM audit WHERE action LIKE ${`%memory ${memoryId}%`}`).toHaveLength(
      2,
    );
  } finally {
    await sql`DELETE FROM jobs WHERE payload->>'agentId' IN (${sarah}, ${john})`;
    await sql`DELETE FROM email_threads WHERE agent_id=${sarah}`;
    await sql`DELETE FROM simulation_runs WHERE agent_id IN (${sarah}, ${john})`;
    await sql`DELETE FROM agent_configurations WHERE agent_id IN (${sarah}, ${john})`;
    await sql`DELETE FROM agents WHERE id IN (${sarah}, ${john})`;
    await sql`DELETE FROM audit WHERE action LIKE ${`%memory ${memoryId}%`}`;
    await sql.end();
  }
});
