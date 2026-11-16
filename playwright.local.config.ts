import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results/local-auth',
  testMatch: 'local-auth.spec.ts',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3001',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
  },
  webServer: {
    command: 'bun run --filter @orbit/web dev',
    url: 'http://127.0.0.1:3001/health',
    timeout: 120000,
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'development',
      PORT: '3001',
      DATABASE_URL: 'postgres://orbit:orbit_dev@127.0.0.1:5432/orbit_test',
      APP_URL: 'http://127.0.0.1:3001',
      AUTH_DISABLED: 'true',
      AUTH_LOCAL_ADMIN_EMAIL: 'local-admin@example.test',
      ORBIT_ADMIN_EMAIL: '',
      ORBIT_ADMIN_PASSWORD: '',
    },
  },
});
