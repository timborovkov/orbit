import { parseObservabilityEnv } from '@/lib/observability/env';
import { optionalResendApiKey } from '@/lib/runtime/email/settings';
import { optionalXBearerToken } from '@/lib/runtime/x/settings';

/** Worker process env — shared module so web/worker both typecheck without Nest-style packages. */
function optionalHexKey(value: string | undefined) {
  if (!value) return undefined;
  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error('ORBIT_ENCRYPTION_KEY must be a 64-character hex string');
  }
  return value;
}

function optionalOpenRouterKey(value: string | undefined) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.length > 512) {
    throw new Error('OPENROUTER_API_KEY must be a non-empty key without spaces');
  }
  return trimmed;
}

export function parseWorkerEnv(input: Record<string, string | undefined>) {
  const databaseUrl = input.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  try {
    new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid URL');
  }
  const workerId = input.ORBIT_WORKER_ID?.trim();
  if (workerId !== undefined && (workerId.length < 1 || workerId.length > 120)) {
    throw new Error('ORBIT_WORKER_ID must be 1–120 characters');
  }
  return {
    DATABASE_URL: databaseUrl,
    ORBIT_ENCRYPTION_KEY: optionalHexKey(input.ORBIT_ENCRYPTION_KEY),
    OPENROUTER_API_KEY: optionalOpenRouterKey(input.OPENROUTER_API_KEY),
    RESEND_API_KEY: optionalResendApiKey.parse(input.RESEND_API_KEY),
    X_BEARER_TOKEN: optionalXBearerToken.parse(input.X_BEARER_TOKEN),
    ORBIT_WORKER_ID: workerId === '' ? undefined : workerId,
    observability: parseObservabilityEnv(input),
  };
}

export function workerEnvConfig() {
  return parseWorkerEnv(process.env);
}
