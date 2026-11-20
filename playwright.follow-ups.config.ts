import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results/follow-ups',
  testMatch: 'follow-ups-screenshots.spec.ts',
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3003',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
  },
  webServer: {
    command: 'bun run --filter @orbit/web start',
    url: 'http://127.0.0.1:3003/health',
    timeout: 180000,
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'production',
      PORT: '3003',
      DATABASE_URL: 'postgres://orbit:orbit_dev@127.0.0.1:5432/orbit_test',
      APP_URL: 'http://127.0.0.1:3003',
      HOSTNAME: '127.0.0.1',
      AUTH_DISABLED: 'false',
      ORBIT_ADMIN_EMAIL: 'admin@example.com',
      ORBIT_ADMIN_PASSWORD: 'test-only-password-123456',
      OPENROUTER_API_KEY: '',
      ORBIT_ENCRYPTION_KEY: 'a'.repeat(64),
    },
  },
});
