import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

const sql = postgres('postgres://orbit:orbit_dev@localhost:5432/orbit_test');
const email = 'admin@example.com';
const password = 'test-only-password-123456';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
}
async function create(page: Page, name: string, mission: string) {
  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  await page.getByLabel(/^Name/).fill(name);
  await page.getByLabel(/^Mission/).fill(mission);
  await page.getByRole('button', { name: 'Create paused agent' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
async function accessible(page: Page) {
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
test.beforeEach(async () => {
  await sql`TRUNCATE simulation_runs, agent_credentials, agent_configurations, sessions, agents, audit, login_attempts`;
  await sql`UPDATE controls SET paused=true`;
});
test.afterAll(async () => {
  await sql.end();
});
test('private login, persisted workspace, keyboard dialog, themes and screenshots', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto('/');
  await expect(page).toHaveURL(/login/);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('body')).toHaveCSS('font-family', /IBM Plex Sans Variable/);
  expect(await page.evaluate(() => document.fonts.check('400 14px "IBM Plex Sans Variable"'))).toBe(
    true,
  );
  for (const mode of ['dark', 'light']) {
    await page
      .getByRole('radio', { name: mode.charAt(0).toUpperCase() + mode.slice(1), exact: true })
      .check();
    await page.screenshot({ path: `test-results/login-${mode}.png` });
    await accessible(page);
  }
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill('wrong');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('p[role=alert]')).toContainText('Check your credentials');
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'No agents yet' })).toBeVisible();
  await page.screenshot({ path: 'test-results/empty-workspace.png', fullPage: true });
  await accessible(page);
  const trigger = page.getByRole('button', { name: 'Create agent', exact: true });
  await trigger.click();
  await expect(page.getByLabel(/^Name/)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByLabel('Template', { exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Close dialog' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Template', { exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel(/^Name/)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel(/^Mission/)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await create(
    page,
    'Sarah',
    'Resolve customer questions using approved knowledge and escalate when a human is needed.',
  );
  await create(
    page,
    'John',
    'Research relevant opportunities and arrange product demos with interested prospects.',
  );
  await create(
    page,
    'Alex',
    'Identify useful connections and seek consent before making an introduction.',
  );
  expect((await sql`SELECT status,mode FROM agents WHERE name='Sarah'`)[0]).toMatchObject({
    status: 'paused',
    mode: 'shadow',
  });
  const releaseRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && Boolean(request.headers()['next-action']),
  );
  await page.getByRole('button', { name: 'Release global pause' }).click();
  await expect(page.getByRole('button', { name: 'Pause all outbound actions' })).toBeVisible();
  expect((await sql`SELECT paused FROM controls`)[0].paused).toBe(false);
  const captured = await releaseRequest;
  const body = captured.postDataBuffer();
  if (!body) throw new Error('Expected a pause mutation body');
  const replay = await page.request.post('/', {
    data: body,
    headers: {
      origin: 'http://localhost:3000',
      'next-action': captured.headers()['next-action'],
      'content-type': captured.headers()['content-type'],
    },
  });
  expect(replay.ok()).toBe(true);
  expect((await sql`SELECT paused FROM controls`)[0].paused).toBe(false);

  // The screenshot represents the safer paused default after exercising both real mutations.
  await page.getByRole('button', { name: 'Pause all outbound actions' }).click();
  await expect(page.getByRole('button', { name: 'Release global pause' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sarah', exact: true })).toBeVisible();
  await page.getByRole('radio', { name: 'Auto', exact: true }).check();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(10, 10, 10)');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(250, 250, 250)');
  await page.getByRole('radio', { name: 'Auto', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Auto', exact: true })).toBeChecked();
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Auto', exact: true })).toBeChecked();
  for (const mode of ['dark', 'light']) {
    await page
      .getByRole('radio', { name: mode.charAt(0).toUpperCase() + mode.slice(1), exact: true })
      .check();
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width >= 1024 ? 1000 : 844 });
      await page.evaluate(() => scrollTo(0, 0));
      await noOverflow(page);
      await accessible(page);
      if (width === 1440)
        await page.locator('.theme-switch').screenshot({ path: `test-results/theme-${mode}.png` });
      if (width === 1440 || width === 390)
        await page.screenshot({
          path: `test-results/dashboard-${width === 1440 ? 'desktop' : 'mobile'}-${mode}.png`,
          fullPage: true,
        });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await trigger.click();
  await accessible(page);
  await page.screenshot({ path: 'test-results/create-agent.png' });
  await page.keyboard.press('Escape');
  const cookie = (await page.context().cookies()).find((c) => c.name === 'orbit-session');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/login/);
  await page.goto('/');
  await expect(page).toHaveURL(/login/);
});
test('validation, failed requests and pending feedback preserve entries', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  await page.getByLabel(/^Name/).fill('   ');
  await page.getByLabel(/^Mission/).fill('Help customers.');
  await page.getByRole('button', { name: 'Create paused agent' }).click();
  await expect(page.locator('#name-error')).toBeVisible();
  await expect(page.getByLabel(/^Name/)).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel(/^Name/)).toBeFocused();
  await expect(page.getByLabel(/^Mission/)).toHaveValue('Help customers.');
  await page.getByLabel(/^Name/).fill('Sarah');
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/*', async (route) => {
    if (route.request().method() === 'POST' && route.request().headers()['next-action']) {
      await blocked;
      await route.fulfill({ status: 503, body: 'Service unavailable' });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Create paused agent' }).click();
  await expect(page.getByRole('button', { name: 'Creating…' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  release();
  await expect(page.locator('p[role=alert]')).toContainText('Check your connection and try again');
  await expect(page.getByLabel(/^Name/)).toHaveValue('Sarah');
  await expect(page.getByLabel(/^Mission/)).toHaveValue('Help customers.');
  await page.unrouteAll();
  await page.getByRole('button', { name: 'Create paused agent' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect((await sql`SELECT count(*)::int AS count FROM agents`)[0].count).toBe(1);
});
test('worst-case content, full missions, text zoom, RTL and touch controls', async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  const name =
    'Aleksandra Wiśniewska-Kowalczyk · Customer relationships and technical partnerships';
  const mission =
    'Build trusted relationships with customers, answer technical questions using approved sources, and keep every commitment visible. '
      .repeat(15)
      .slice(0, 2000);
  await create(page, name.slice(0, 80), mission);
  await page.setViewportSize({ width: 320, height: 844 });
  await noOverflow(page);
  await expect(page.locator('.agent-mission')).toBeVisible();
  await expect(page.locator('.agent-mission')).toHaveText(mission.trim());
  await noOverflow(page);
  await accessible(page);
  await page.screenshot({ path: 'test-results/stress-mobile.png', fullPage: true });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await noOverflow(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
    document.documentElement.dir = 'rtl';
  });
  await noOverflow(page);
  await page.screenshot({ path: 'test-results/stress-rtl.png', fullPage: true });
  await page.evaluate(() => {
    document.documentElement.dir = 'ltr';
  });
  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  await expect(page.getByLabel(/^Name/)).toHaveCSS('font-size', '16px');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByRole('button', { name: 'Create paused agent' })).toHaveCSS(
    'transition-duration',
    '0s',
  );
});
test('expired and revoked sessions, forged cookies, and durable login limits', async ({
  page,
  context,
}) => {
  for (const [token, fingerprint, expiry] of [
    ['expired', digest(password), new Date(Date.now() - 1000)],
    ['revoked', digest('old-password'), new Date(Date.now() + 3600000)],
  ] as const) {
    await sql`INSERT INTO sessions VALUES (${digest(token)},${email},${fingerprint},${expiry})`;
    await context.addCookies([
      { name: 'orbit-session', value: token, url: 'http://localhost:3000' },
    ]);
    await page.goto('/');
    await expect(page).toHaveURL(/login/);
  }
  await context.addCookies([
    { name: 'orbit-session', value: 'forged', url: 'http://localhost:3000' },
  ]);
  await page.goto('/');
  await expect(page).toHaveURL(/login/);
  await sql`INSERT INTO login_attempts VALUES ('admin',10,now())`;
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('p[role=alert]')).toContainText('Try again in 15 minutes');
});

test('login layout, password visibility and errors across themes and screen sizes', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto('/login');
  for (const mode of ['dark', 'light']) {
    await page
      .getByRole('radio', { name: mode === 'dark' ? 'Dark' : 'Light', exact: true })
      .check();
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width >= 1024 ? 1000 : 844 });
      await noOverflow(page);
      await expect(page.getByLabel(/^Email/)).toBeVisible();
      await expect(page.getByLabel(/^Password/)).toBeVisible();
      await accessible(page);
      if (width === 1440 || width === 390) {
        await page.screenshot({
          path: `test-results/login-${width === 1440 ? 'desktop' : 'mobile'}-${mode}.png`,
          fullPage: true,
        });
      }
    }
  }
  await page.getByLabel(/^Password/).fill('test-only-visible-password');
  await page.getByRole('button', { name: 'Show password', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel(/^Password/)).toHaveAttribute('type', 'text');
  await expect(page.getByLabel(/^Password/)).toHaveValue('test-only-visible-password');
  await page.getByRole('button', { name: 'Hide password', exact: true }).click();
  await expect(page.getByLabel(/^Password/)).toHaveAttribute('type', 'password');
  await page.getByLabel(/^Email/).fill(email);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#login-error')).toContainText('Check your credentials');
  await page.setViewportSize({ width: 390, height: 500 });
  await page.getByRole('button', { name: 'Sign in', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeInViewport();
  await noOverflow(page);
  await accessible(page);
  await page.screenshot({ path: 'test-results/login-error-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await noOverflow(page);
  await expect(page.getByRole('button', { name: 'Show password', exact: true })).toBeVisible();
});
