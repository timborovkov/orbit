const REDACTED = '[redacted]';

const secretKey =
  /(?:^|_)(?:password|passwd|secret|token|apikey|api_key|authorization|credential|cookie|private_key|encryption_key|access_key|secret_key|auth_token|dsn)$/i;

const secretValue =
  /(?:sk-[a-z0-9_-]{8,}|bearer\s+\S+|basic\s+[a-z0-9+/=]{8,}|(?:pk|sk)-lf-[a-z0-9-]+|(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{20,}|[a-f0-9]{64})/gi;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const traceId = /^[0-9a-f]{32}$/i;
const integer = /^-?\d+$/;
const modelId = /^[\w.-]+\/[\w.:-]+$/;

const orbitTagKeys = [
  'orbit.agent_id',
  'orbit.run_id',
  'orbit.job_id',
  'orbit.configuration_id',
  'orbit.configuration_version',
  'orbit.lifecycle',
  'orbit.stage',
  'orbit.operation',
  'orbit.trigger',
  'orbit.environment',
  'orbit.tool',
  'orbit.policy_decision',
  'orbit.budget_violation',
  'orbit.langfuse_trace_id',
] as const;

const allowedTagKeys = new Set<string>(orbitTagKeys);

const allowedEnums = new Set([
  'shadow',
  'paused',
  'live',
  'stopped',
  'evaluator',
  'main',
  'playground',
  'production',
  'development',
  'test',
  'allow',
  'deny',
  'needs-approval',
  'suppressed',
  'denied',
  'reply',
  'like',
  'repost',
  'follow',
  'bookmark',
  'introduce',
  'escalate',
  'web.request',
  'worker.queue',
  'worker.inference',
  'worker.settlement',
  'worker.dead_letter',
  'worker.runtime',
  'unknown-price',
  'daily-spend',
  'monthly-spend',
  'daily-requests',
  'monthly-requests',
  'daily-outbound',
  'monthly-outbound',
  'concurrency',
  'tool-steps',
  'run-deadline',
  'cancelled',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keyLooksSecret(key: string) {
  const normalized = key.replace(/[^a-z0-9]+/gi, '_');
  return secretKey.test(normalized);
}

/** Redact secret-shaped substrings in a string. */
export function redactString(value: string) {
  return value.replace(secretValue, REDACTED);
}

const sqlParamsSection = /(?:^|\n)params:\s*[\s\S]*$/i;

/**
 * Strip SQL bind parameters and oversized payloads from exception text.
 * DrizzleQueryError embeds query params (including saved prompts) in `message`.
 */
function sanitizeExceptionMessage(value: string) {
  let message = sqlParamsSection.test(value)
    ? value.replace(sqlParamsSection, '\nparams: [redacted]')
    : value;
  message = redactString(message);
  if (message.length > 200) return `${message.slice(0, 180)} [redacted]`;
  return message;
}

function dropSqlParamKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => dropSqlParamKeys(entry));
  if (!isPlainObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = key.toLowerCase() === 'params' ? REDACTED : dropSqlParamKeys(nested);
  }
  return result;
}

/**
 * Recursively redact secrets from JSON-like values. Prompt/model content is
 * stripped unless `captureContent` is true; secret keys and values are always
 * removed.
 */
export function redactValue(value: unknown, options: { captureContent?: boolean } = {}): unknown {
  const captureContent = options.captureContent === true;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // Omit prose/prompts unless capture is explicitly enabled. Identifiers (UUIDs,
    // model ids, enums) have no whitespace and stay available as attributes.
    if (!captureContent && (value.includes(' ') || value.length > 80)) return REDACTED;
    return redactString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, options));
  if (!isPlainObject(value)) return REDACTED;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (keyLooksSecret(key)) {
      result[key] = REDACTED;
      continue;
    }
    result[key] = redactValue(nested, options);
  }
  return result;
}

function isSafeTagValue(value: string) {
  return (
    uuid.test(value) ||
    traceId.test(value) ||
    integer.test(value) ||
    modelId.test(value) ||
    allowedEnums.has(value)
  );
}

/**
 * Build Sentry/Langfuse tags from trusted identifiers only.
 * Inbound external content, prompts, drafts and secrets never become tags.
 */
export function safeOrbitTags(
  input: Record<string, string | number | boolean | undefined | null>,
): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [rawKey, raw] of Object.entries(input)) {
    if (raw === undefined || raw === null) continue;
    const key = rawKey.startsWith('orbit.') ? rawKey : `orbit.${rawKey}`;
    if (!allowedTagKeys.has(key) || keyLooksSecret(key)) continue;
    const value = String(raw);
    if (!isSafeTagValue(value)) continue;
    tags[key] = value;
  }
  return tags;
}

export interface SentryLikeEvent {
  message?: string;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, Primitive>;
  request?: {
    headers?: Record<string, string>;
    data?: unknown;
    cookies?: unknown;
    query_string?: unknown;
    env?: unknown;
  };
  breadcrumbs?:
    { message?: string; data?: unknown }[] | { values?: { message?: string; data?: unknown }[] };
  exception?: { values?: { value?: string; type?: string }[] };
  user?: unknown;
  extra_data?: unknown;
}

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

const droppedRequestHeaders = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
]);

function redactCrumb<T extends { message?: string; data?: unknown }>(crumb: T): T {
  return {
    ...crumb,
    message: crumb.message ? sanitizeExceptionMessage(crumb.message) : crumb.message,
    data: crumb.data ? redactValue(crumb.data, { captureContent: false }) : crumb.data,
  };
}

function redactBreadcrumbs(breadcrumbs: SentryLikeEvent['breadcrumbs']) {
  if (!breadcrumbs) return breadcrumbs;
  if (Array.isArray(breadcrumbs)) return breadcrumbs.map((crumb) => redactCrumb(crumb));
  return { values: (breadcrumbs.values ?? []).map((crumb) => redactCrumb(crumb)) };
}

/** Strip PII, request bodies, secrets and untrusted tag values from a Sentry event. */
export function redactSentryEvent<T extends SentryLikeEvent>(event: T): T {
  const tags: Record<string, Primitive> = {};
  for (const [key, value] of Object.entries(event.tags ?? {})) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      continue;
    }
    for (const [safeKey, safeValue] of Object.entries(safeOrbitTags({ [key]: value }))) {
      tags[safeKey] = safeValue;
    }
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.request?.headers ?? {})) {
    if (droppedRequestHeaders.has(key.toLowerCase()) || keyLooksSecret(key)) continue;
    headers[key] = redactString(value);
  }
  return {
    ...event,
    message: event.message ? sanitizeExceptionMessage(event.message) : event.message,
    user: undefined,
    extra: event.extra
      ? (dropSqlParamKeys(redactValue(event.extra, { captureContent: false })) as Record<
          string,
          unknown
        >)
      : undefined,
    contexts: event.contexts
      ? (dropSqlParamKeys(redactValue(event.contexts, { captureContent: false })) as Record<
          string,
          unknown
        >)
      : undefined,
    tags,
    request: event.request
      ? {
          ...event.request,
          data: undefined,
          cookies: undefined,
          query_string: undefined,
          env: undefined,
          headers,
        }
      : undefined,
    breadcrumbs: redactBreadcrumbs(event.breadcrumbs),
    exception: event.exception
      ? {
          values: (event.exception.values ?? []).map((item) => ({
            ...item,
            value: item.value ? sanitizeExceptionMessage(item.value) : item.value,
          })),
        }
      : undefined,
  };
}

/** Replace secret-bearing or oversized error messages while keeping stack frames. */
export function sanitizeError(error: unknown, fallback: string): Error {
  if (!(error instanceof Error)) return new Error(fallback);
  const redacted = sanitizeExceptionMessage(error.message);
  if (redacted !== error.message || secretKey.test(error.message)) {
    const sanitized = new Error(fallback);
    sanitized.name = error.name;
    sanitized.stack = error.stack;
    return sanitized;
  }
  return error;
}
