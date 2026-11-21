import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { listMigrationFiles, migrateDatabase, ORBIT_MIGRATION_LOCK_KEY } from '@orbit/migrate';

import { startWeb } from '../../scripts/start-web';

type FakeRow = { name: string };

function createFakeSql(options?: { failOnUnsafe?: boolean; applied?: Set<string> }) {
  const applied = options?.applied ?? new Set<string>();
  const statements: string[] = [];
  let began = false;

  const tx = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.reduce(
        (acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''),
        '',
      );
      statements.push(text);
      if (text.includes('FROM orbit_migrations WHERE name=')) {
        const name = String(values[0]);
        return Promise.resolve(applied.has(name) ? ([{ name }] satisfies FakeRow[]) : []);
      }
      if (text.includes('INSERT INTO orbit_migrations')) {
        applied.add(String(values[0]));
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    },
    {
      unsafe: async (sqlText: string) => {
        statements.push(sqlText);
        if (options?.failOnUnsafe) throw new Error('forced migration failure');
        return [];
      },
    },
  );

  const sql = {
    begin: async (fn: (txClient: typeof tx) => Promise<void>) => {
      began = true;
      await fn(tx);
    },
    end: async () => {
      statements.push('END');
    },
    applied,
    statements,
    get began() {
      return began;
    },
  };

  return sql;
}

describe('migrateDatabase', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test('lists SQL files in sorted order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orbit-migrate-'));
    tempDirs.push(dir);
    await writeFile(join(dir, '0002_b.sql'), 'SELECT 2');
    await writeFile(join(dir, '0001_a.sql'), 'SELECT 1');
    await writeFile(join(dir, 'readme.txt'), 'ignore');

    expect(await listMigrationFiles(pathToFileURL(`${dir}/`))).toEqual([
      '0001_a.sql',
      '0002_b.sql',
    ]);
  });

  test('takes the advisory lock and skips already-applied migrations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orbit-migrate-'));
    tempDirs.push(dir);
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE a(id int)');
    await writeFile(join(dir, '0002_b.sql'), 'CREATE TABLE b(id int)');

    const sql = createFakeSql({ applied: new Set(['0001_a.sql']) });
    await migrateDatabase({
      databaseUrl: 'postgres://unused',
      migrationsDir: pathToFileURL(`${dir}/`),
      sql: sql as never,
    });

    expect(sql.began).toBe(true);
    expect(
      sql.statements.some((s) => s.includes(`pg_advisory_xact_lock(${ORBIT_MIGRATION_LOCK_KEY})`)),
    ).toBe(true);
    expect(sql.statements).toContain('CREATE TABLE b(id int)');
    expect(sql.statements).not.toContain('CREATE TABLE a(id int)');
    expect(sql.applied.has('0001_a.sql')).toBe(true);
    expect(sql.applied.has('0002_b.sql')).toBe(true);
  });

  test('is idempotent when every migration is already recorded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orbit-migrate-'));
    tempDirs.push(dir);
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE a(id int)');

    const sql = createFakeSql({ applied: new Set(['0001_a.sql']) });
    await migrateDatabase({
      databaseUrl: 'postgres://unused',
      migrationsDir: pathToFileURL(`${dir}/`),
      sql: sql as never,
    });

    expect(sql.statements.filter((s) => s === 'CREATE TABLE a(id int)')).toHaveLength(0);
    expect(sql.applied.size).toBe(1);
  });

  test('propagates SQL failures so callers can exit non-zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orbit-migrate-'));
    tempDirs.push(dir);
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE a(id int)');

    const sql = createFakeSql({ failOnUnsafe: true });
    await expect(
      migrateDatabase({
        databaseUrl: 'postgres://unused',
        migrationsDir: pathToFileURL(`${dir}/`),
        sql: sql as never,
      }),
    ).rejects.toThrow('forced migration failure');
  });

  test('requires DATABASE_URL when no client is injected', async () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(migrateDatabase()).rejects.toThrow('DATABASE_URL is required');
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});

describe('startWeb', () => {
  test('refuses to start the server when migration fails', async () => {
    let spawned = false;
    const code = await startWeb({
      migrate: async () => {
        throw new Error('boom');
      },
      spawnServer: async () => {
        spawned = true;
        return 0;
      },
      serverPath: '/tmp/does-not-matter.js',
    });

    expect(code).toBe(1);
    expect(spawned).toBe(false);
  });

  test('starts the server after a successful migration', async () => {
    const calls: string[][] = [];
    const code = await startWeb({
      migrate: async () => {},
      spawnServer: async (_command, args) => {
        calls.push(args);
        return 0;
      },
      serverPath: '/tmp/orbit-server.js',
    });

    expect(code).toBe(0);
    expect(calls).toEqual([['--bun', '--no-env-file', '/tmp/orbit-server.js']]);
  });
});
