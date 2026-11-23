import { execFileSync } from 'node:child_process';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import postgres from 'postgres';

import { getPicture } from '@/lib/storage/objects';

const sql = postgres('postgres://orbit:orbit_dev@localhost:5432/orbit_test');
test.afterAll(async () => {
  await sql.end();
});
test('private agent pictures survive RustFS restart, preserve edits and support replacement and removal', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  Object.assign(process.env, {
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'orbit-test',
    S3_ACCESS_KEY_ID: 'orbit_local',
    S3_SECRET_ACCESS_KEY: 'orbit_local_storage_only',
  });
  await sql`TRUNCATE agent_memory_evidence_revisions, agent_memories, person_relationship_notes, person_identity_changes, person_link_rejections, person_contacts, person_identities, people, evaluation_comparisons, evaluation_cases, agent_activity_events, follow_ups, outbound_actions, source_events, discovery_cursors, email_messages, email_threads, email_mailboxes, knowledge_chunks, knowledge_documents, knowledge_library_grants, knowledge_libraries, recipient_consents, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, agent_skills, agent_mcp_connections, skills, mcp_connections, sessions, agents, audit, login_attempts`;
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill('admin@example.com');
  await page.getByLabel(/^Password/).fill('test-only-password-123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  for (const name of ['John', 'Sarah']) {
    await page.getByRole('button', { name: 'Create agent', exact: true }).click();
    await page.getByLabel('Template', { exact: true }).click();
    await page
      .getByRole('option', {
        name: name === 'John' ? 'Sales and GTM' : 'Customer Support',
        exact: true,
      })
      .click();
    await page.getByLabel(/^Name/).fill(name);
    await page.getByRole('button', { name: 'Create shadow agent' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  }
  await page.getByRole('link', { name: 'John', exact: true }).click();
  await expect(page).toHaveURL(/\/agents\//);
  await expect(page.getByRole('button', { name: 'Upload picture' })).toBeEnabled();
  await page
    .getByLabel('Personality', { exact: true })
    .fill('Unsaved personality survives picture upload');
  await page
    .getByLabel('Profile picture', { exact: true })
    .setInputFiles('tests/fixtures/profile.png');
  await expect(page.getByText('Picture saved.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Personality', { exact: true })).toHaveValue(
    'Unsaved personality survives picture upload',
  );
  const [john] = await sql`SELECT id,picture_key FROM agents WHERE name='John'`;
  expect(john.picture_key).toMatch(new RegExp(`^agents/${john.id}/pictures/.*\\.webp$`));
  const [sarah] = await sql`SELECT picture_key FROM agents WHERE name='Sarah'`;
  expect(sarah.picture_key).toBeNull();
  expect((await sql`SELECT * FROM agent_configurations WHERE agent_id=${john.id}`).length).toBe(1);
  const picturePath = `/agents/${john.id}/picture`;
  const response = await page.request.get(picturePath);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('image/webp');
  expect(response.headers()['cache-control']).toBe('private, no-store');
  const original = await response.body();
  const anonymous = await browser.newContext();
  const denied = await anonymous.request.get(picturePath, { maxRedirects: 0 });
  expect(denied.status()).toBe(307);
  await anonymous.close();
  expect(
    (await page.request.get(`http://localhost:9000/orbit-test/${john.picture_key}`)).status(),
  ).toBe(403);
  execFileSync('docker', ['compose', 'stop', 'rustfs'], { stdio: 'pipe' });
  try {
    await page
      .getByLabel('Profile picture', { exact: true })
      .setInputFiles('tests/fixtures/profile.png');
    await expect(page.locator('.picture-editor').getByRole('alert')).toContainText(
      'Picture storage is unavailable',
      {
        timeout: 20000,
      },
    );
    expect((await sql`SELECT picture_key FROM agents WHERE id=${john.id}`)[0].picture_key).toBe(
      john.picture_key,
    );
  } finally {
    execFileSync('docker', ['compose', 'start', 'rustfs'], { stdio: 'pipe' });
  }
  await expect
    .poll(async () => (await page.request.get(picturePath)).status(), { timeout: 30000 })
    .toBe(200);
  expect(await (await page.request.get(picturePath)).body()).toEqual(original);
  await page.reload();
  await expect(page.getByRole('img', { name: 'John profile picture' })).toHaveCount(2);
  for (const mode of ['Light', 'Dark']) {
    await page.getByRole('radio', { name: mode, exact: true }).check();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      if (width !== 320)
        await page.screenshot({
          path: `test-results/profile-picture-${mode}-${width}.png`,
          fullPage: true,
        });
    }
  }
  await page
    .getByLabel('Profile picture', { exact: true })
    .setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('<svg/>') });
  await expect(page.locator('.picture-editor').getByRole('alert')).toContainText(
    'JPEG, PNG or WebP',
  );
  expect((await sql`SELECT picture_key FROM agents WHERE id=${john.id}`)[0].picture_key).toBe(
    john.picture_key,
  );
  await page
    .getByLabel('Profile picture', { exact: true })
    .setInputFiles('tests/fixtures/profile.png');
  await expect(page.getByText('Picture saved.', { exact: true })).toBeVisible();
  const [replaced] = await sql`SELECT picture_key FROM agents WHERE id=${john.id}`;
  expect(replaced.picture_key).not.toBe(john.picture_key);
  await expect(getPicture(john.picture_key)).rejects.toThrow();
  await page.goto('/');
  await expect(page.getByRole('img', { name: 'John profile picture' })).toBeVisible();
  await page.getByRole('link', { name: 'John', exact: true }).click();
  await page.getByRole('button', { name: 'Remove picture' }).click();
  await expect(page.getByText('Picture removed.', { exact: true })).toBeVisible();
  expect((await page.request.get(picturePath)).status()).toBe(404);
  await expect(getPicture(replaced.picture_key)).rejects.toThrow();
  expect((await sql`SELECT picture_key FROM agents WHERE id=${john.id}`)[0].picture_key).toBeNull();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Upload picture' })).toBeVisible();
});
