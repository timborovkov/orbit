import { readdir, readFile } from 'node:fs/promises';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for migrations');
const sql = postgres(databaseUrl, { max: 1 });
try {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(712604)`;
    await tx`CREATE TABLE IF NOT EXISTS orbit_migrations (name text PRIMARY KEY)`;
    const files = (await readdir(new URL('../apps/web/drizzle/', import.meta.url)))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const name of files) {
      if ((await tx`SELECT name FROM orbit_migrations WHERE name=${name}`).length) continue;
      await tx.unsafe(
        await readFile(new URL(`../apps/web/drizzle/${name}`, import.meta.url), 'utf8'),
      );
      await tx`INSERT INTO orbit_migrations VALUES (${name})`;
    }
  });
} finally {
  await sql.end();
}
