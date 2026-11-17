import { describe, expect, test } from 'bun:test';

import { parseEnv } from '@/lib/env';

const local = {
  NODE_ENV: 'development',
  AUTH_DISABLED: 'true',
  ORBIT_LOCAL_DEV_SERVER: 'loopback',
  APP_URL: 'http://127.0.0.1:3001',
  DATABASE_URL: 'postgres://orbit:orbit_dev@127.0.0.1:5432/orbit_test',
  AUTH_LOCAL_ADMIN_EMAIL: 'local-admin@example.test',
};
describe('local authentication configuration', () => {
  test('allows an explicit local identity without bootstrap credentials', () => {
    expect(parseEnv(local)).toMatchObject({
      AUTH_DISABLED: true,
      AUTH_LOCAL_ADMIN_EMAIL: local.AUTH_LOCAL_ADMIN_EMAIL,
    });
  });
  for (const nodeEnv of ['production', 'test', undefined])
    test(`rejects bypass with NODE_ENV=${nodeEnv}`, () => {
      expect(() => parseEnv({ ...local, NODE_ENV: nodeEnv })).toThrow('NODE_ENV=development');
    });
  for (const url of [
    'https://orbit.example.com',
    'http://0.0.0.0:3001',
    'http://localhost.example.com',
    'http://192.168.1.2:3001',
  ])
    test(`rejects non-loopback APP_URL ${url}`, () => {
      expect(() => parseEnv({ ...local, APP_URL: url })).toThrow('loopback APP_URL');
    });
  test('requires a local database and guarded launcher', () => {
    expect(() =>
      parseEnv({ ...local, DATABASE_URL: 'postgres://user:password@database.example.com/orbit' }),
    ).toThrow('loopback DATABASE_URL');
    expect(() => parseEnv({ ...local, ORBIT_LOCAL_DEV_SERVER: undefined })).toThrow(
      'loopback-only',
    );
  });
  test('requires an explicit valid local identity', () => {
    expect(() => parseEnv({ ...local, AUTH_LOCAL_ADMIN_EMAIL: undefined })).toThrow();
    expect(() => parseEnv({ ...local, AUTH_LOCAL_ADMIN_EMAIL: 'not-an-email' })).toThrow();
  });
  test('accepts exact true/false flags and keeps login enabled by default', () => {
    for (const flag of ['1', 'yes', 'TRUE', ''])
      expect(() => parseEnv({ ...local, AUTH_DISABLED: flag })).toThrow();
    for (const flag of ['false', undefined]) {
      expect(() => parseEnv({ ...local, AUTH_DISABLED: flag })).toThrow();
      expect(
        parseEnv({
          ...local,
          AUTH_DISABLED: flag,
          ORBIT_ADMIN_EMAIL: 'admin@example.com',
          ORBIT_ADMIN_PASSWORD: 'test-only-password-123456',
        }).AUTH_DISABLED,
      ).toBe(false);
    }
  });
});

test('production server rejects bypass at startup before serving health', async () => {
  const child = Bun.spawn(
    [process.execPath, 'run', '--filter', '@orbit/web', 'start', '--port', '3002'],
    {
      cwd: new URL('../', import.meta.url).pathname,
      env: { ...process.env, ...local, NODE_ENV: 'production' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(status).toBe(1);
    expect(stdout + stderr).toContain('AUTH_DISABLED requires NODE_ENV=development');
    await expect(
      fetch('http://127.0.0.1:3002/health', { signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow();
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}, 20000);

describe('password authentication configuration', () => {
  const production = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://user:password@database.example.com/orbit',
    APP_URL: 'https://orbit.example.com',
    ORBIT_ADMIN_EMAIL: 'admin@example.com',
    ORBIT_ADMIN_PASSWORD: 'test-only-password-123456',
  };
  test('requires credentials and HTTPS for public production origins', () => {
    expect(parseEnv(production).AUTH_DISABLED).toBe(false);
    expect(() => parseEnv({ ...production, ORBIT_ADMIN_PASSWORD: 'short' })).toThrow();
    expect(() => parseEnv({ ...production, ORBIT_ADMIN_EMAIL: undefined })).toThrow();
    expect(() => parseEnv({ ...production, APP_URL: 'http://orbit.example.com' })).toThrow('HTTPS');
    expect(parseEnv({ ...production, APP_URL: 'http://127.0.0.1:3000' }).AUTH_DISABLED).toBe(false);
  });
  test('rejects malformed URLs in both modes', () => {
    expect(() => parseEnv({ ...production, APP_URL: 'invalid' })).toThrow();
    expect(() => parseEnv({ ...local, DATABASE_URL: 'invalid' })).toThrow();
  });
  test('treats OPENROUTER_API_KEY as an optional non-empty server secret', () => {
    expect(parseEnv(production).OPENROUTER_API_KEY).toBeUndefined();
    expect(parseEnv({ ...production, OPENROUTER_API_KEY: '' }).OPENROUTER_API_KEY).toBeUndefined();
    expect(
      parseEnv({ ...production, OPENROUTER_API_KEY: 'sk-or-test-key' }).OPENROUTER_API_KEY,
    ).toBe('sk-or-test-key');
    expect(() => parseEnv({ ...production, OPENROUTER_API_KEY: 'has spaces' })).toThrow();
  });
});
