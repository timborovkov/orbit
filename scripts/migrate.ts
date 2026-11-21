import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

/** Postgres advisory lock key shared by pre-deploy and startup migrators. */
export const ORBIT_MIGRATION_LOCK_KEY = 712604;

const defaultMigrationsDir = new URL('../apps/web/drizzle/', import.meta.url);

export type MigrationSql = ReturnType<typeof postgres>;

export type MigrateDatabaseOptions = {
  databaseUrl?: string;
  migrationsDir?: URL;
  /** Inject a client in tests; when set, the caller owns `end()`. */
  sql?: MigrationSql;
};

export async function listMigrationFiles(
  migrationsDir: URL = defaultMigrationsDir,
): Promise<string[]> {
  return (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
}

export async function migrateDatabase(options: MigrateDatabaseOptions = {}): Promise<void> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for migrations');

  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir;
  const owned = !options.sql;
  const sql = options.sql ?? postgres(databaseUrl, { max: 1, onnotice: () => {} });

  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${ORBIT_MIGRATION_LOCK_KEY})`;
      await tx`CREATE TABLE IF NOT EXISTS orbit_migrations (name text PRIMARY KEY)`;
      const files = await listMigrationFiles(migrationsDir);
      for (const name of files) {
        if ((await tx`SELECT name FROM orbit_migrations WHERE name=${name}`).length) continue;
        await tx.unsafe(await readFile(new URL(name, migrationsDir), 'utf8'));
        await tx`INSERT INTO orbit_migrations VALUES (${name})`;
      }
    });
  } finally {
    if (owned) await sql.end();
  }
}

async function main(): Promise<void> {
  await migrateDatabase();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('[migrate] failed', error);
    process.exit(1);
  });
}
