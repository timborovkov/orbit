import { z } from 'zod';

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLoopback = (value: string) =>
  URL.canParse(value) && loopbackHosts.has(new URL(value).hostname);
const base = z.object({
  DATABASE_URL: z.url(),
  APP_URL: z.url(),
  ORBIT_ENCRYPTION_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
  ),
  // Server-only default OpenRouter key. Never send to the browser, prompts or diagnostics.
  OPENROUTER_API_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine((value) => !/\s/.test(value), 'OPENROUTER_API_KEY must not contain spaces')
      .optional(),
  ),
});
const passwordAuth = base
  .extend({
    AUTH_DISABLED: z.literal('false'),
    NODE_ENV: z.string().optional(),
    ORBIT_ADMIN_EMAIL: z.email(),
    ORBIT_ADMIN_PASSWORD: z.string().min(16),
  })
  .refine(
    (config) =>
      config.NODE_ENV !== 'production' ||
      new URL(config.APP_URL).protocol === 'https:' ||
      isLoopback(config.APP_URL),
    { path: ['APP_URL'], message: 'Production APP_URL must use HTTPS' },
  );
const localAuth = base.extend({
  AUTH_DISABLED: z.literal('true'),
  NODE_ENV: z.literal('development', { error: 'AUTH_DISABLED requires NODE_ENV=development' }),
  // The launcher supplies this only when it binds the listener to loopback.
  // A localhost APP_URL alone cannot prove the server is not listening on 0.0.0.0.
  ORBIT_LOCAL_DEV_SERVER: z.literal('loopback', {
    error: 'AUTH_DISABLED requires the loopback-only bun run dev launcher',
  }),
  AUTH_LOCAL_ADMIN_EMAIL: z.email(),
  APP_URL: z
    .url()
    .refine(
      (value) => isLoopback(value) && ['http:', 'https:'].includes(new URL(value).protocol),
      'AUTH_DISABLED requires a loopback APP_URL',
    ),
  DATABASE_URL: z.url().refine(isLoopback, 'AUTH_DISABLED requires a loopback DATABASE_URL'),
});
const configuration = z.discriminatedUnion('AUTH_DISABLED', [passwordAuth, localAuth]);

export function parseEnv(input: Record<string, string | undefined>) {
  const config = configuration.parse({ ...input, AUTH_DISABLED: input.AUTH_DISABLED ?? 'false' });
  return config.AUTH_DISABLED === 'true'
    ? { ...config, AUTH_DISABLED: true as const }
    : { ...config, AUTH_DISABLED: false as const };
}
export function env() {
  return parseEnv(process.env);
}
