import type { Page } from '@playwright/test';

/** Blur focus so skip links and rings do not appear in review screenshots. */
export async function capturePage(
  page: Page,
  path: string,
  options: { fullPage?: boolean } = { fullPage: true },
) {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  await page.screenshot({ path, fullPage: options.fullPage });
}
