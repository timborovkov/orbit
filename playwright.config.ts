import { defineConfig } from '@playwright/test';

export const orbitTestWebServer = {
  url: 'http://localhost:3000/login',
  reuseExistingServer: false,
  env: {
    DATABASE_URL: 'postgres://orbit:orbit_dev@localhost:5432/orbit_test',
    APP_URL: 'http://localhost:3000',
    AUTH_DISABLED: 'false',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'orbit-test',
    S3_ACCESS_KEY_ID: 'orbit_local',
    S3_SECRET_ACCESS_KEY: 'orbit_local_storage_only',
    ORBIT_ENCRYPTION_KEY: 'a'.repeat(64),
    // Explicitly empty so a developer shell export cannot leak into Access "none" states.
    OPENROUTER_API_KEY: '',
    ORBIT_ADMIN_EMAIL: 'admin@example.com',
    ORBIT_ADMIN_PASSWORD: 'test-only-password-123456',
    ORBIT_WORKER_ID: 'playwright-worker',
    KNOWLEDGE_EMBEDDING_STUB: 'true',
  },
};

export default defineConfig({
  testDir: './tests',
  testMatch: [
    'foundation.spec.ts',
    'skills-mcp.spec.ts',
    'workspace.spec.ts',
    'pictures.spec.ts',
    'runtime-safety.spec.ts',
    'knowledge.spec.ts',
    'inbound-email.spec.ts',
    'people.spec.ts',
  ],
  workers: 1,
  use: {
    baseURL: 'http://localhost:3000',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    },
  },
  webServer: {
    command: 'bun scripts/playwright-stack.ts',
    ...orbitTestWebServer,
    env: {
      ...orbitTestWebServer.env,
      RESEND_INBOUND_DOMAIN: 'inbound.example.test',
      RESEND_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 17).toString('base64')}`,
    },
  },
});
