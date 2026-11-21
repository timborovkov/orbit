import { expect, type Page } from '@playwright/test';

/** Open a workspace task tab, using the compact Select on narrow viewports. */
export async function openWorkspaceTab(page: Page, name: string | RegExp) {
  const pattern = typeof name === 'string' ? new RegExp(`^${name}`) : name;
  const tab = page.getByRole('tab', { name: pattern });
  const select = page.getByRole('combobox', { name: 'Agent workspace section', exact: true });

  // The desktop tabs can be rendered before React switches to the compact view.
  if (!(await page.evaluate(() => matchMedia('(max-width: 600px)').matches))) {
    await tab.first().click({ timeout: 15000 });
    return;
  }

  await select.click({ timeout: 15000 });
  await page.getByRole('option', { name: pattern }).click();
}

/** Open an Access subsection, using the compact Select on narrow viewports. */
export async function openAccessSection(page: Page, name: string) {
  const button = page.locator('.access-sections button', { hasText: name });
  const select = page.getByRole('combobox', { name: 'Access section', exact: true });

  await expect(button.or(select).first()).toBeVisible({ timeout: 15000 });

  if ((await button.count()) > 0 && (await button.first().isVisible())) {
    await button.first().click();
    return;
  }

  await select.click();
  await page.getByRole('option', { name, exact: true }).click();
}
