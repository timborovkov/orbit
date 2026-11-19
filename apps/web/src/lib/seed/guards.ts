const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLocalDatabaseUrl(databaseUrl: string): boolean {
  try {
    const host = new URL(databaseUrl).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host);
  } catch {
    return false;
  }
}

export interface SeedSafetyInput {
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
  allowNonLocal: boolean;
}

export type SeedSafetyResult = { ok: true } | { ok: false; reason: string };

/**
 * Refuse production and non-loopback databases unless an explicit override is set.
 * Does not mutate environment or connect to the database.
 */
export function assertSafeToSeed(input: SeedSafetyInput): SeedSafetyResult {
  if (input.nodeEnv === 'production') {
    return {
      ok: false,
      reason:
        'Refusing to seed: NODE_ENV=production. Demo seeding is never permitted in production.',
    };
  }
  if (!input.databaseUrl) {
    return { ok: false, reason: 'Refusing to seed: DATABASE_URL is required.' };
  }
  if (!isLocalDatabaseUrl(input.databaseUrl) && !input.allowNonLocal) {
    return {
      ok: false,
      reason:
        'Refusing to seed: DATABASE_URL is not a loopback host. Pass --allow-non-local to override for a remote development database.',
    };
  }
  // Production is already blocked above; allowNonLocal only unlocks non-loopback hosts.
  return { ok: true };
}
