import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { env } from './env';
const globalDb = globalThis as unknown as {
  orbitSql?: ReturnType<typeof postgres>;
};
export function db() {
  globalDb.orbitSql ??= postgres(env().DATABASE_URL, { max: 5 });
  return drizzle(globalDb.orbitSql);
}
