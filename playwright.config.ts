import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: 'foundation.spec.ts',
  workers: 1,
  use: {
    baseURL: 'http://localhost:3000',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    },
  },
  webServer: {
    command: 'bun run --filter @orbit/web start',
    url: 'http://localhost:3000/login',
    reuseExistingServer: false,
    env: {
      DATABASE_URL: 'postgres://orbit:orbit_dev@localhost:5432/orbit_test',
      APP_URL: 'http://localhost:3000',
      AUTH_DISABLED: 'false',
      ORBIT_ADMIN_EMAIL: 'admin@example.com',
      ORBIT_ADMIN_PASSWORD: 'test-only-password-123456',
    },
  },
});
