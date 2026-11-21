import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

type RailwayConfig = {
  build?: { builder?: string; dockerfilePath?: string };
  deploy?: {
    preDeployCommand?: string[];
    healthcheckPath?: string;
    restartPolicyType?: string;
  };
};

const migrateCommand = 'env NODE_ENV=production bun --bun --no-env-file scripts/migrate.ts';

describe('Railway deploy migration config', () => {
  test('web pre-deploy runs migrations with Bun', () => {
    const config = JSON.parse(readFileSync('apps/web/railway.json', 'utf8')) as RailwayConfig;
    expect(config.build?.builder).toBe('DOCKERFILE');
    expect(config.build?.dockerfilePath).toBe('docker/web.Dockerfile');
    expect(config.deploy?.preDeployCommand).toEqual([migrateCommand]);
    expect(config.deploy?.healthcheckPath).toBe('/health');
  });

  test('worker pre-deploy runs the same migration command', () => {
    const config = JSON.parse(readFileSync('apps/worker/railway.json', 'utf8')) as RailwayConfig;
    expect(config.build?.builder).toBe('DOCKERFILE');
    expect(config.build?.dockerfilePath).toBe('docker/worker.Dockerfile');
    expect(config.deploy?.preDeployCommand).toEqual([migrateCommand]);
    expect(config.deploy?.restartPolicyType).toBe('ON_FAILURE');
  });

  test('runtime images ship migrate script, drizzle SQL, and web start wrapper', () => {
    const webDockerfile = readFileSync('docker/web.Dockerfile', 'utf8');
    const workerDockerfile = readFileSync('docker/worker.Dockerfile', 'utf8');

    expect(webDockerfile).toContain(
      'COPY --chown=bun:bun scripts/migrate.ts scripts/start-web.ts ./scripts/',
    );
    expect(webDockerfile).toContain('COPY --chown=bun:bun apps/web/drizzle ./apps/web/drizzle');
    expect(webDockerfile).toContain(
      'CMD ["bun", "--bun", "--no-env-file", "scripts/start-web.ts"]',
    );

    expect(workerDockerfile).toContain(
      'COPY --chown=bun:bun scripts/migrate.ts ./scripts/migrate.ts',
    );
    expect(workerDockerfile).toContain('COPY --chown=bun:bun apps/web/drizzle ./apps/web/drizzle');
  });
});
