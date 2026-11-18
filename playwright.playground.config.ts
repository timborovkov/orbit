import { defineConfig } from '@playwright/test';

import workspaceConfig, { orbitTestWebServer } from './playwright.config';

export default defineConfig({
  ...workspaceConfig,
  testMatch: 'playground-recovery.spec.ts',
  outputDir: './test-results/playground',
  // The test starts its one-shot worker after verifying the pending state on reload.
  webServer: {
    command: 'bun run --filter @orbit/web start',
    ...orbitTestWebServer,
  },
});
