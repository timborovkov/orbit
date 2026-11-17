import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/**
 * Database URL only — shared by web and worker. Full admin auth env stays in env.ts
 * so the worker can start with DATABASE_URL (+ encryption key) alone.
 */
function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  try {
    new URL(url);
  } catch {
    throw new Error('DATABASE_URL must be a valid URL');
  }
  return url;
}

const globalDb = globalThis as unknown as {
  orbitSql?: ReturnType<typeof postgres>;
};

export function sqlClient() {
  globalDb.orbitSql ??= postgres(databaseUrl(), { max: 5 });
  return globalDb.orbitSql;
}

export function db() {
  return drizzle(sqlClient());
}

export type Db = ReturnType<typeof db>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function closeDb() {
  if (globalDb.orbitSql) {
    await globalDb.orbitSql.end({ timeout: 5 });
    globalDb.orbitSql = undefined;
  }
}
