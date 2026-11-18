import { z } from 'zod';

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

function emptyToUndefined(value: unknown) {
  return value === '' || value === undefined ? undefined : value;
}

function isLoopbackUrl(value: URL) {
  return loopbackHosts.has(value.hostname);
}

function httpsOrLoopbackHttp(value: string, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopbackUrl(url)) return url;
  throw new Error(`${label} must use HTTPS (HTTP is allowed only on loopback)`);
}

function parseSentryDsn(value: string) {
  const url = httpsOrLoopbackHttp(value, 'SENTRY_DSN');
  if (!url.username || url.password || url.search || url.hash) {
    throw new Error('SENTRY_DSN must be a Sentry DSN without a password, query or fragment');
  }
  if (!/^[\w-]+$/.test(url.username)) {
    throw new Error('SENTRY_DSN public key is invalid');
  }
  const project = url.pathname.split('/').filter(Boolean).at(-1);
  if (!project || !/^\d+$/.test(project)) {
    throw new Error('SENTRY_DSN must include a numeric project id');
  }
  return url.href;
}

function parseLangfuseBaseUrl(value: string) {
  const url = httpsOrLoopbackHttp(value, 'LANGFUSE_BASE_URL');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('LANGFUSE_BASE_URL must not include credentials, query or fragment');
  }
  return url.href.replace(/\/$/, '');
}

const optionalSecret = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .min(1)
    .max(512)
    .refine((value) => !/\s/.test(value), 'must not contain spaces')
    .optional(),
);

/** Empty/missing rates use 0.1; invalid values also fall back (client-safe). */
export function resolveTracesSampleRate(value: string | undefined, fallback = 0.1) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function tracesSampleRate(label: string) {
  return z.preprocess(emptyToUndefined, z.string().optional()).transform((value, ctx) => {
    if (value === undefined) return 0.1;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      ctx.addIssue({
        code: 'custom',
        message: `${label} must be a number between 0 and 1`,
      });
      return z.NEVER;
    }
    return parsed;
  });
}

const captureContent = z.preprocess(emptyToUndefined, z.enum(['true', 'false']).optional());

const observability = z
  .object({
    SENTRY_DSN: z.preprocess(emptyToUndefined, z.string().optional()),
    NEXT_PUBLIC_SENTRY_DSN: z.preprocess(emptyToUndefined, z.string().optional()),
    SENTRY_TRACES_SAMPLE_RATE: tracesSampleRate('SENTRY_TRACES_SAMPLE_RATE'),
    NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: tracesSampleRate(
      'NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE',
    ),
    SENTRY_AUTH_TOKEN: optionalSecret,
    SENTRY_ORG: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(120).optional()),
    SENTRY_PROJECT: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(120).optional()),
    LANGFUSE_PUBLIC_KEY: optionalSecret,
    LANGFUSE_SECRET_KEY: optionalSecret,
    LANGFUSE_BASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),
    LANGFUSE_CAPTURE_CONTENT: captureContent,
  })
  .superRefine((value, ctx) => {
    if (value.SENTRY_DSN) {
      try {
        parseSentryDsn(value.SENTRY_DSN);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['SENTRY_DSN'],
          message: error instanceof Error ? error.message : 'Invalid SENTRY_DSN',
        });
      }
    }
    if (value.NEXT_PUBLIC_SENTRY_DSN) {
      try {
        parseSentryDsn(value.NEXT_PUBLIC_SENTRY_DSN);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['NEXT_PUBLIC_SENTRY_DSN'],
          message: error instanceof Error ? error.message : 'Invalid NEXT_PUBLIC_SENTRY_DSN',
        });
      }
    }
    const publicKey = value.LANGFUSE_PUBLIC_KEY;
    const secretKey = value.LANGFUSE_SECRET_KEY;
    if ((publicKey && !secretKey) || (!publicKey && secretKey)) {
      ctx.addIssue({
        code: 'custom',
        path: publicKey ? ['LANGFUSE_SECRET_KEY'] : ['LANGFUSE_PUBLIC_KEY'],
        message: 'LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set together',
      });
    }
    if (value.LANGFUSE_BASE_URL) {
      try {
        parseLangfuseBaseUrl(value.LANGFUSE_BASE_URL);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['LANGFUSE_BASE_URL'],
          message: error instanceof Error ? error.message : 'Invalid LANGFUSE_BASE_URL',
        });
      }
    }
  });

export interface ObservabilityEnv {
  sentryDsn?: string;
  nextPublicSentryDsn?: string;
  sentryTracesSampleRate: number;
  nextPublicSentryTracesSampleRate: number;
  sentryAuthToken?: string;
  sentryOrg?: string;
  sentryProject?: string;
  langfuse?: {
    publicKey: string;
    secretKey: string;
    baseUrl: string;
    captureContent: boolean;
  };
}

export function parseObservabilityEnv(
  input: Record<string, string | undefined> = process.env,
): ObservabilityEnv {
  const parsed = observability.parse(input);
  return {
    sentryDsn: parsed.SENTRY_DSN ? parseSentryDsn(parsed.SENTRY_DSN) : undefined,
    nextPublicSentryDsn: parsed.NEXT_PUBLIC_SENTRY_DSN
      ? parseSentryDsn(parsed.NEXT_PUBLIC_SENTRY_DSN)
      : undefined,
    sentryTracesSampleRate: parsed.SENTRY_TRACES_SAMPLE_RATE,
    nextPublicSentryTracesSampleRate: parsed.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
    sentryAuthToken: parsed.SENTRY_AUTH_TOKEN,
    sentryOrg: parsed.SENTRY_ORG,
    sentryProject: parsed.SENTRY_PROJECT,
    langfuse:
      parsed.LANGFUSE_PUBLIC_KEY && parsed.LANGFUSE_SECRET_KEY
        ? {
            publicKey: parsed.LANGFUSE_PUBLIC_KEY,
            secretKey: parsed.LANGFUSE_SECRET_KEY,
            baseUrl: parsed.LANGFUSE_BASE_URL
              ? parseLangfuseBaseUrl(parsed.LANGFUSE_BASE_URL)
              : 'https://cloud.langfuse.com',
            captureContent: parsed.LANGFUSE_CAPTURE_CONTENT === 'true',
          }
        : undefined,
  };
}

export function observabilityEnvironment() {
  return process.env.NODE_ENV === 'production' ? 'production' : 'development';
}
