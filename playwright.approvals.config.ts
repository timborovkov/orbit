import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Keep outside the Turbopack monorepo root so Playwright artifacts do not remount the app.
  outputDir: '/tmp/playwright-approvals-results',
  testMatch: 'approvals-screenshots.spec.ts',
  workers: 1,
  use: {
    // Port 3002 avoids Cloud Agent Chrome CDP sessions that often bind/reload :3001.
    baseURL: 'http://127.0.0.1:3002',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
  },
  webServer: {
    command: 'bun run --filter @orbit/web dev',
    url: 'http://127.0.0.1:3002/health',
    timeout: 180000,
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'development',
      PORT: '3002',
      DATABASE_URL: 'postgres://orbit:orbit_dev@127.0.0.1:5432/orbit_test',
      APP_URL: 'http://127.0.0.1:3002',
      AUTH_DISABLED: 'true',
      AUTH_LOCAL_ADMIN_EMAIL: 'local-admin@example.test',
      ORBIT_ADMIN_EMAIL: '',
      ORBIT_ADMIN_PASSWORD: '',
      ORBIT_ENCRYPTION_KEY: 'a'.repeat(64),
      NEXT_DISABLE_DEV_INDICATOR: '1',
    },
  },
});
