import { execFileSync } from 'node:child_process';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { openAccessSection, openWorkspaceTab } from './workspace-nav';

const databaseUrl = 'postgres://orbit:orbit_dev@localhost:5432/orbit_test';

test('Maya’s introduction waits for both people and revocation blocks an approved draft', async ({
  page,
}) => {
  test.setTimeout(60_000);
  execFileSync('bun', ['run', 'db:seed:demo', '--reset'], {
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl },
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/people/introductions');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel(/^Email/).fill('admin@example.com');
  await page.getByLabel(/^Password/).fill('test-only-password-123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();

  await page.goto('/people');
  await page.getByRole('link', { name: 'Introductions', exact: true }).click();
  await page.getByRole('link', { name: /Alex Chen and Priya Patel/ }).click();
  await expect(page.getByRole('heading', { name: 'Alex Chen and Priya Patel' })).toBeVisible();
  await expect(page.getByText('Waiting for consent', { exact: true })).toBeVisible();

  const alex = page.getByRole('region', { name: 'Alex Chen' });
  const priya = page.getByRole('region', { name: 'Priya Patel' });
  await expect(alex.getByText('Would share with Priya Patel')).toBeVisible();
  await expect(priya.getByText('Would share with Alex Chen')).toBeVisible();
  await alex.getByLabel('Evidence reference').fill('Alex agreed to the displayed disclosure.');
  await alex.getByRole('combobox', { name: 'Decision' }).click();
  await page.getByRole('option', { name: 'Agreed', exact: true }).click();
  await alex.getByRole('button', { name: 'Record decision' }).click();
  await expect(alex.getByRole('button', { name: 'Record revocation' })).toBeVisible();
  await expect(alex.getByText('Agreed', { exact: true })).toBeVisible();
  await expect(priya.getByText('Awaiting decision', { exact: true })).toBeVisible();
  await expect(page.getByText('Waiting for consent', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Introduction draft' })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await priya.getByLabel('Evidence reference').fill('Priya agreed to the displayed disclosure.');
  await priya.getByRole('combobox', { name: 'Decision' }).click();
  await page.getByRole('option', { name: 'Agreed', exact: true }).click();
  await priya.getByRole('button', { name: 'Record decision' }).click();
  await expect(page.getByText('Ready for review', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Introduction draft' })).toContainText(
    'Hello Alex Chen and Priya Patel',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);

  await page.getByRole('link', { name: 'View in Approvals' }).click();
  const draft = page
    .locator('li.approvals-card')
    .filter({ hasText: 'Hello Alex Chen and Priya Patel' });
  await expect(draft.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await draft.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(draft.getByText('approved', { exact: true })).toBeVisible();
  await draft.getByRole('link', { name: 'View disclosure and consent' }).click();
  await expect(page.getByText('Approved draft', { exact: true })).toBeVisible();

  await alex.getByLabel('Evidence reference').fill('Alex withdrew permission after approval.');
  await alex.getByRole('button', { name: 'Record revocation' }).click();
  await expect(page.getByText('Blocked', { exact: true })).toBeVisible();
  await expect(alex.getByText('Revoked', { exact: true })).toBeVisible();
  await expect(priya.getByText('Agreed', { exact: true })).toBeVisible();
  await expect(page.getByText('Administrator approved the draft.')).toBeVisible();

  await page.getByRole('link', { name: /Proposed by Maya/ }).click();
  await openWorkspaceTab(page, 'Access');
  await openAccessSection(page, 'Consent');
  const revokeGrant = page.getByRole('button', { name: 'Disable introduction proposals' });
  const grant = page.getByRole('button', { name: 'Enable introduction proposals' });
  await revokeGrant.click();
  await expect(grant).toBeVisible();
  await grant.click();
  await expect(revokeGrant).toBeVisible();
});
