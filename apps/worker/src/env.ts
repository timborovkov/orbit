import { z } from 'zod';

const workerEnv = z.object({
  DATABASE_URL: z.url(),
  ORBIT_ENCRYPTION_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
  ),
  // Same optional server default as the web process. resolveOpenRouterApiKey reads process.env.
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
  ORBIT_WORKER_ID: z.string().min(1).max(120).optional(),
});

export function parseWorkerEnv(input: Record<string, string | undefined>) {
  return workerEnv.parse(input);
}

export function workerEnvConfig() {
  return parseWorkerEnv(process.env);
}
