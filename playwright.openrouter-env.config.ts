import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results/openrouter-env',
  testMatch: 'access-env.spec.ts',
  workers: 1,
  use: {
    baseURL: 'http://localhost:3003',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    },
  },
  webServer: {
    command: 'bun run --filter @orbit/web start --port 3003',
    url: 'http://localhost:3003/login',
    reuseExistingServer: false,
    env: {
      DATABASE_URL: 'postgres://orbit:orbit_dev@localhost:5432/orbit_test',
      APP_URL: 'http://localhost:3003',
      AUTH_DISABLED: 'false',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'orbit-test',
      S3_ACCESS_KEY_ID: 'orbit_local',
      S3_SECRET_ACCESS_KEY: 'orbit_local_storage_only',
      ORBIT_ENCRYPTION_KEY: 'a'.repeat(64),
      OPENROUTER_API_KEY: 'test-only-env-default-never-use',
      ORBIT_ADMIN_EMAIL: 'admin@example.com',
      ORBIT_ADMIN_PASSWORD: 'test-only-password-123456',
    },
  },
});
