import { z } from 'zod';

const baseSchema = z.object({
  DATABASE_URL: z.url(),
  APP_URL: z.url(),
  AUTH_DISABLED: z.enum(['true', 'false']).default('false'),
});
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
export function parseEnv(input: Record<string, string | undefined>) {
  const base = baseSchema.parse(input);
  const appUrl = new URL(base.APP_URL);
  if (base.AUTH_DISABLED === 'true') {
    if (input.NODE_ENV !== 'development')
      throw new Error('AUTH_DISABLED requires NODE_ENV=development');
    if (input.ORBIT_LOCAL_DEV_SERVER !== 'loopback')
      throw new Error('AUTH_DISABLED requires the loopback-only bun run dev launcher');
    if (!loopbackHosts.has(appUrl.hostname) || !['http:', 'https:'].includes(appUrl.protocol))
      throw new Error('AUTH_DISABLED requires a loopback APP_URL');
    if (!loopbackHosts.has(new URL(base.DATABASE_URL).hostname))
      throw new Error('AUTH_DISABLED requires a loopback DATABASE_URL');
    const identity = z.object({ AUTH_LOCAL_ADMIN_EMAIL: z.email() }).parse(input);
    return { ...base, ...identity, AUTH_DISABLED: true as const };
  }
  const credentials = z
    .object({ ORBIT_ADMIN_EMAIL: z.email(), ORBIT_ADMIN_PASSWORD: z.string().min(16) })
    .parse(input);
  if (
    input.NODE_ENV === 'production' &&
    appUrl.protocol !== 'https:' &&
    !loopbackHosts.has(appUrl.hostname)
  )
    throw new Error('Production APP_URL must use HTTPS');
  return { ...base, ...credentials, AUTH_DISABLED: false as const };
}
export function env() {
  return parseEnv(process.env);
}
