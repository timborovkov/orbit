import { randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import postgres from 'postgres';

import { capturePage } from './screenshot';

test('the email and X surfaces share a People record and unlink preserves both sources', async ({
  page,
}, testInfo) => {
  const sql = postgres('postgres://orbit:orbit_dev@localhost:5432/orbit_test');
  const agent = randomUUID();
  const secondAgent = randomUUID();
  const thread = randomUUID();
  const sender = `people-${agent}@example.test`;
  const author = `people-${agent}`;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await sql`truncate sessions, login_attempts`;
    await sql`insert into agents (id, name, mission) values (${agent}, 'People browser fixture', 'Help customers')`;
    await sql`insert into agents (id, name, mission) values (${secondAgent}, 'People research fixture', 'Research customer needs')`;
    const [config] = await sql`insert into agent_configurations (agent_id, version, config, actor)
      select ${agent}, 1, config || jsonb_build_object('name', 'People browser fixture'), 'fixture' from templates where id = 'support' returning id`;
    const [run] =
      await sql`insert into simulation_runs (agent_id, configuration_id, origin, input, status, actor, result, expires_at)
      values (${agent}, ${config.id}, 'discovery', 'Fixture X evaluation', 'completed', 'fixture', '{"steps":[],"actions":[],"error":null}', now()) returning id`;
    const employment = 'I work at Acme.';
    const [emailRun] =
      await sql`insert into simulation_runs (agent_id, configuration_id, origin, input, status, actor, result, expires_at)
      values (${agent}, ${config.id}, 'email', ${employment}, 'completed', 'fixture', '{"steps":[],"actions":[],"error":null}', now()) returning id`;
    await sql`insert into email_threads (id, agent_id) values (${thread}, ${agent})`;
    const [message] =
      await sql`insert into email_messages (agent_id, thread_id, resend_email_id, event, received_at, sender, subject, body, run_id)
      values (${agent}, ${thread}, ${randomUUID()}, '{}', now(), ${sender}, 'People fixture email', ${`Account question\n${employment}`}, ${emailRun.id}) returning id`;
    await sql`insert into agent_memories
      (agent_id, subject_kind, subject, topic, identity_key, fact, quote, run_id, source_kind, source_id, source_at, person_field, person_value)
      values (${agent}, 'person', 'Riley', 'Company', 'fixture-employment', 'Riley works at Acme.', ${employment},
        ${emailRun.id}, 'email', ${message.id}, now(), 'company', 'Acme')`;
    await sql`insert into person_relationship_notes (agent_id, email_message_id, summary, excerpt)
      values (${agent}, ${message.id}, 'The sender has an account question.', 'Account question')`;
    await sql`insert into source_events (agent_id, provider, provider_event_id, payload, text, author_id, author_username, run_id)
      values (${agent}, 'x', '301', '{}', 'People fixture X activity', ${author}, 'people_fixture', ${run.id})`;

    const emailUrl = `/agents/${agent}?tab=email&emailThread=${thread}`;
    const xUrl = `/agents/${agent}?run=${run.id}`;
    await page.goto(emailUrl);
    await page.getByLabel(/^Email/).fill('admin@example.com');
    await page.getByLabel(/^Password/).fill('test-only-password-123456');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Workspace' })
      .getByRole('link', { name: 'People', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
    const providerPost = 'https://x.com/i/web/status/301';
    await page.context().route(providerPost, (route) => route.fulfill({ body: 'Original X post' }));
    const directoryPost = page.getByRole('link', { name: /^People fixture X activity/ });
    const [sourceTab] = await Promise.all([page.waitForEvent('popup'), directoryPost.click()]);
    await expect(sourceTab).toHaveURL(providerPost);
    await expect(page).toHaveURL(/\/people$/);
    await sourceTab.close();
    await page.goto(emailUrl);
    const senderLink = page.getByRole('link', { name: 'View sender in People' });
    const emailPerson = await senderLink.getAttribute('href');
    expect(emailPerson).toMatch(/^\/people\//);
    await senderLink.click();
    await expect(page.getByRole('heading', { name: sender })).toBeVisible();

    await page.goto(xUrl);
    const authorLink = page.getByRole('link', { name: 'View X author in People' });
    const xPerson = await authorLink.getAttribute('href');
    expect(xPerson).not.toBe(emailPerson);
    const sourceRun = page.locator(`#run-${run.id}`);
    const originalPost = { name: /^View original on X/ };
    await expect(sourceRun.getByRole('link', originalPost)).toHaveAttribute('href', providerPost);
    await expect(sourceRun.getByRole('link', originalPost)).toHaveAttribute('target', '_blank');
    await sourceRun.getByLabel('Case title').fill('X lead case');
    await sourceRun.getByRole('button', { name: 'Save as case' }).click();
    await expect(sourceRun.getByRole('status')).toContainText('Saved as evaluation case.');
    await capturePage(page, testInfo.outputPath('x-history.png'));
    await page.goto(`/evaluations?agent=${agent}`);
    const savedCase = page.getByRole('row').filter({ hasText: 'X lead case' });
    await expect(savedCase.getByRole('link', originalPost)).toHaveAttribute('href', providerPost);
    await expect(savedCase.getByRole('link', originalPost)).toHaveAttribute('target', '_blank');
    await capturePage(page, testInfo.outputPath('x-evaluation-case.png'));
    await page.goto(xUrl);
    await authorLink.click();
    await page.getByRole('link', { name: 'Link to another person' }).click();
    await page.getByRole('searchbox', { name: 'Search people' }).fill(sender);
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByRole('link', { name: new RegExp(sender) }).click();
    await page.getByLabel('Reason for linking').fill('Reviewed both source records.');
    await page.getByRole('button', { name: 'Link identity', exact: true }).click();
    const timeline = page.getByRole('region', { name: 'Timeline' });
    await expect(timeline.getByText('People fixture email')).toBeVisible();
    await expect(timeline.getByText('People fixture X activity')).toBeVisible();
    await expect(timeline.getByRole('link', originalPost)).toHaveAttribute('href', providerPost);
    await expect(timeline.getByRole('link', originalPost)).toHaveAttribute('target', '_blank');
    await expect(page.getByRole('link', { name: 'Email evidence', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'X evidence', exact: true })).toBeVisible();
    await capturePage(page, testInfo.outputPath('cross-channel-people.png'));
    await expect(page.getByRole('heading', { name: 'Private relationship notes' })).toHaveCount(0);
    await page.getByLabel('Agent', { exact: true }).selectOption(agent);
    await page.getByRole('button', { name: 'Set agent' }).click();
    await expect(page.getByText('The sender has an account question.')).toBeVisible();
    const privateFacts = page.getByRole('region', { name: 'Private memory facts' });
    await expect(privateFacts.getByText('Acme', { exact: true })).toBeVisible();
    await privateFacts.getByRole('link', { name: 'View original source' }).click();
    await expect(page.getByRole('link', { name: 'Open email thread' })).toHaveAttribute(
      'href',
      `${emailUrl}&emailMessage=${message.id}#message-${message.id}`,
    );
    await page.goto(`/agents/${agent}?tab=memory`);
    const memory = page.locator('.memory-detail');
    await memory.locator('summary').click();
    await memory.getByLabel('Company', { exact: true }).fill('Acme Labs');
    await memory.getByRole('button', { name: 'Save correction' }).click();
    await expect(memory.locator('summary')).toContainText('Riley works at Acme Labs.');
    await memory.getByRole('link', { name: 'View person' }).click();
    await expect(privateFacts.getByText('Acme Labs', { exact: true })).toBeVisible();
    await capturePage(page, testInfo.outputPath('person-memory.png'));
    await page.getByLabel('Agent', { exact: true }).selectOption(secondAgent);
    await page.getByRole('button', { name: 'Set agent' }).click();
    await expect(page.getByText('The sender has an account question.')).toHaveCount(0);
    await expect(timeline.getByText('People fixture email')).toHaveCount(0);
    await expect(privateFacts).toHaveCount(0);
    await page.getByLabel('Agent', { exact: true }).selectOption(agent);
    await page.getByRole('button', { name: 'Set agent' }).click();
    await sql`insert into email_messages (agent_id, thread_id, resend_email_id, event, received_at, sender, subject, body)
      select ${agent}, ${thread}, gen_random_uuid(), '{}', original.received_at + n * interval '1 microsecond',
        ${sender}, 'Newer email ' || n, 'Follow-up'
      from email_messages original cross join generate_series(1, 50) n where original.id = ${message.id}`;
    await page.getByRole('link', { name: 'Open supporting interaction' }).click();
    await expect(page).toHaveURL(new RegExp(`emailMessage=${message.id}`));
    await expect(page.locator(`#message-${message.id}`)).toContainText('Account question');
    await expect(page.getByRole('link', { name: 'Newer messages' })).toBeVisible();
    await sql`delete from email_messages where agent_id = ${agent} and subject like 'Newer email %'`;

    await page.goto(xUrl);
    await expect(authorLink).toHaveAttribute('href', emailPerson!);
    await authorLink.click();
    await expect(page.getByRole('heading', { name: sender })).toBeVisible();
    await page.locator('summary').filter({ hasText: 'Add a phone number' }).click();
    await page.getByLabel('Phone number in international format').fill('+442079460000');
    await page.getByRole('button', { name: 'Add phone number', exact: true }).click();
    await expect(page.getByText('Phone · SMS and voice')).toBeVisible();
    await page.locator('summary').filter({ hasText: 'Add an Instagram account' }).click();
    await page.getByLabel('Instagram handle').fill('fixture_person');
    await page.getByLabel('Instagram account ID (optional)').fill(`ig-${agent}`);
    await page.getByRole('button', { name: 'Add Instagram account', exact: true }).click();
    await expect(page.getByText('@fixture_person')).toBeVisible();
    await sql`insert into source_events (agent_id, provider, provider_event_id, payload, text, author_id, author_username)
      values (${agent}, 'x', '302', '{}', 'People fixture later X activity', ${author}, 'people_renamed')
      on conflict do nothing`;
    await sql`insert into source_events (agent_id, provider, provider_event_id, payload, text, author_id, author_username)
      values (${agent}, 'x', '302', '{}', 'People fixture later X activity', ${author}, 'people_renamed')
      on conflict do nothing`;
    await sql`insert into email_messages (agent_id, thread_id, resend_email_id, event, received_at, sender, subject, body)
      values (${agent}, ${thread}, ${randomUUID()}, '{}', now(), ${sender}, 'People fixture later email', 'A follow-up')`;
    await page.reload();
    await expect(timeline.getByText('People fixture later X activity')).toHaveCount(1);
    await expect(timeline.getByText('People fixture later email')).toHaveCount(1);

    await page.setViewportSize({ width: 390, height: 844 });
    for (const theme of ['Light', 'Dark']) {
      await page.getByRole('radio', { name: theme, exact: true }).check();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
      const audit = await new AxeBuilder({ page })
        .include('.people-workspace')
        .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
        .analyze();
      expect(audit.violations).toEqual([]);
    }
    const unlink = page.locator('summary').filter({ hasText: 'Unlink identity' });
    await unlink.focus();
    await page.keyboard.press('Enter');
    await page.getByLabel('Reason for unlinking').fill('The account belongs to someone else.');
    await page.getByRole('button', { name: 'Unlink identity', exact: true }).click();
    await expect(timeline.getByText('People fixture X activity')).toHaveCount(0);
    await expect(timeline.getByText('People fixture email')).toBeVisible();
    await page.goto(`${xPerson}?agent=${agent}`);
    await expect(privateFacts).toHaveCount(0);
    await page.goto(`${emailPerson}?agent=${agent}`);
    await expect(privateFacts.getByText('Acme Labs', { exact: true })).toBeVisible();
    await page.goto(xUrl);
    await expect(authorLink).toHaveAttribute('href', xPerson!);
    await expect(page.locator(`#run-${run.id} > summary`)).toContainText('Fixture X evaluation');
    await page.goto(emailUrl);
    await expect(senderLink.first()).toHaveAttribute('href', emailPerson!);
    await expect(page.getByRole('heading', { name: 'People fixture email' })).toBeVisible();
  } finally {
    await sql`delete from evaluation_cases where agent_id = ${agent}`;
    await sql`delete from source_events where agent_id = ${agent}`;
    await sql`delete from email_messages where agent_id = ${agent}`;
    await sql`delete from simulation_runs where agent_id = ${agent}`;
    await sql`delete from agent_configurations where agent_id = ${agent}`;
    await sql`delete from agents where id in (${agent}, ${secondAgent})`;
    const identityIds = await sql<{ id: string; home_person_id: string }[]>`
      select id, home_person_id from person_identities where identity_key in (${sender}, ${author})
    `;
    if (identityIds.length) {
      const ids = identityIds.map(({ id }) => id);
      await sql`delete from person_identity_changes where identity_id in ${sql(ids)}`;
      await sql`delete from person_link_rejections where first_identity_id in ${sql(ids)} or second_identity_id in ${sql(ids)}`;
      await sql`delete from person_identities where id in ${sql(ids)}`;
      const peopleIds = identityIds.map(({ home_person_id }) => home_person_id);
      await sql`delete from person_contacts where person_id in ${sql(peopleIds)}`;
      await sql`delete from people where id in ${sql(peopleIds)}`;
    }
    await sql.end();
  }
});
