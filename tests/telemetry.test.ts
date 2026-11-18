import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { parseEnv } from '@/lib/env';
import { parseObservabilityEnv } from '@/lib/observability/env';
import { reportFailure } from '@/lib/observability/errors';
import { redactSentryEvent, redactString, redactValue, safeOrbitTags } from '@/lib/observability/redact';
import {
  createRunTelemetry,
  flushTelemetry,
  getTestSpans,
  installTestTelemetry,
  recordLangfuseScore,
  resetTestTelemetry,
  withOrbitSpan,
} from '@/lib/observability/telemetry';
import { parseWorkerEnv } from '@/lib/worker-env';

const production = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://user:password@database.example.com/orbit',
  APP_URL: 'https://orbit.example.com',
  ORBIT_ADMIN_EMAIL: 'admin@example.com',
  ORBIT_ADMIN_PASSWORD: 'test-only-password-123456',
};

const runId = 'b5357382-f3e5-45af-bbd2-0557ae15c534';
const agentId = '59ba5d9b-ad62-4324-8669-8bc33edf3a6d';
const configurationId = '5eef28f6-3f4e-4242-9218-e68345374052';
const jobId = '0c6d2e1a-4b5f-4c8d-9e0a-1b2c3d4e5f60';
const observabilityKeys = [
  'SENTRY_DSN',
  'NEXT_PUBLIC_SENTRY_DSN',
  'SENTRY_TRACES_SAMPLE_RATE',
  'NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE',
  'SENTRY_AUTH_TOKEN',
  'SENTRY_ORG',
  'SENTRY_PROJECT',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
  'LANGFUSE_CAPTURE_CONTENT',
] as const;

let previousObservability: Array<[string, string | undefined]>;

beforeEach(() => {
  previousObservability = observabilityKeys.map((key) => [key, process.env[key]]);
  for (const key of observabilityKeys) delete process.env[key];
});

afterEach(async () => {
  await resetTestTelemetry();
  for (const [key, value] of previousObservability) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('observability env validation', () => {
  test('treats unset Sentry and Langfuse configuration as disabled', () => {
    expect(parseObservabilityEnv({}).sentryDsn).toBeUndefined();
    expect(parseObservabilityEnv({}).langfuse).toBeUndefined();
    expect(parseEnv(production).observability.langfuse).toBeUndefined();
    expect(parseWorkerEnv({ DATABASE_URL: production.DATABASE_URL }).observability.sentryDsn).toBeUndefined();
  });

  test('treats empty telemetry strings as unset', () => {
    const parsed = parseObservabilityEnv({
      SENTRY_DSN: '',
      LANGFUSE_PUBLIC_KEY: '',
      LANGFUSE_SECRET_KEY: '',
      LANGFUSE_BASE_URL: '',
      LANGFUSE_CAPTURE_CONTENT: '',
      SENTRY_TRACES_SAMPLE_RATE: '',
      NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: '',
    });
    expect(parsed.sentryDsn).toBeUndefined();
    expect(parsed.langfuse).toBeUndefined();
    expect(parsed.sentryTracesSampleRate).toBe(0.1);
    expect(parsed.nextPublicSentryTracesSampleRate).toBe(0.1);
  });

  test('requires a well-formed Sentry DSN and sample rate', () => {
    expect(() => parseObservabilityEnv({ SENTRY_DSN: 'not-a-url' })).toThrow('SENTRY_DSN');
    expect(() =>
      parseObservabilityEnv({ SENTRY_DSN: 'https://public@o1.ingest.sentry.io/1?leak=1' }),
    ).toThrow('SENTRY_DSN');
    expect(() => parseObservabilityEnv({ SENTRY_TRACES_SAMPLE_RATE: '2' })).toThrow(
      'SENTRY_TRACES_SAMPLE_RATE',
    );
    expect(() => parseObservabilityEnv({ NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: '2' })).toThrow(
      'NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE',
    );
    expect(
      parseObservabilityEnv({
        SENTRY_DSN: 'https://publickey@o1.ingest.sentry.io/123',
        SENTRY_TRACES_SAMPLE_RATE: '0.2',
      }).sentryTracesSampleRate,
    ).toBe(0.2);
  });

  test('requires Langfuse keys as a pair and validates the base URL', () => {
    expect(() => parseObservabilityEnv({ LANGFUSE_PUBLIC_KEY: 'pk-lf-test' })).toThrow(
      'LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY',
    );
    expect(() =>
      parseObservabilityEnv({
        LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
        LANGFUSE_SECRET_KEY: 'sk-lf-test',
        LANGFUSE_BASE_URL: 'http://langfuse.example.com',
      }),
    ).toThrow('LANGFUSE_BASE_URL');
    expect(
      parseObservabilityEnv({
        LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
        LANGFUSE_SECRET_KEY: 'sk-lf-test',
        LANGFUSE_CAPTURE_CONTENT: 'true',
      }).langfuse,
    ).toEqual({
      publicKey: 'pk-lf-test',
      secretKey: 'sk-lf-test',
      baseUrl: 'https://cloud.langfuse.com',
      captureContent: true,
    });
  });
});

describe('redaction', () => {
  test('redacts secrets and refuses untrusted tag values', () => {
    expect(redactString('Bearer sk-or-secret-key and pk-lf-aaaa')).toContain('[redacted]');
    expect(
      redactValue(
        {
          OPENROUTER_API_KEY: 'sk-or-secret',
          nested: { authorization: 'Bearer abc', prompt: 'PRIVATE_SYSTEM_PROMPT that is long enough to drop' },
        },
        { captureContent: false },
      ),
    ).toEqual({
      OPENROUTER_API_KEY: '[redacted]',
      nested: { authorization: '[redacted]', prompt: '[redacted]' },
    });
    expect(
      safeOrbitTags({
        agent_id: agentId,
        run_id: runId,
        stage: 'evaluator',
        tool: 'reply',
        draft: 'please follow me',
        input: 'untrusted inbound post',
        OPENROUTER_API_KEY: 'sk-or-secret',
      }),
    ).toEqual({
      'orbit.agent_id': agentId,
      'orbit.run_id': runId,
      'orbit.stage': 'evaluator',
      'orbit.tool': 'reply',
    });
  });

  test('strips request bodies, cookies and unsafe tags from Sentry events', () => {
    const event = redactSentryEvent({
      message: 'Bearer secret-token failed',
      user: { email: 'admin@example.com' },
      tags: { 'orbit.run_id': runId, draft: 'PRIVATE_DRAFT', 'orbit.stage': 'main' },
      request: {
        data: { prompt: 'PRIVATE_PROMPT' },
        cookies: { session: 'abc' },
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      },
      exception: { values: [{ type: 'Error', value: 'sk-or-secret exploded' }] },
    });
    expect(event.user).toBeUndefined();
    expect(event.request?.data).toBeUndefined();
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.headers?.authorization).toBeUndefined();
    expect(event.tags).toEqual({ 'orbit.run_id': runId, 'orbit.stage': 'main' });
    expect(JSON.stringify(event)).not.toMatch(/PRIVATE_|sk-or-secret|secret-token|admin@example.com/);
  });
});

describe('disabled observability', () => {
  test('does not make network calls when exporters are unset', async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      calls.push(String(input));
      return originalFetch(input, init);
    };
    try {
      const telemetry = createRunTelemetry({
        runId,
        agentId,
        configurationId,
        version: 1,
        jobId,
        lifecycle: 'shadow',
      });
      await telemetry.callModel(
        async () => ({
          decision: { relevant: true, reason: 'PRIVATE_RESULT', priority: 1, actions: [] },
          inputTokens: 2,
          outputTokens: 1,
        }),
        {
          model: 'test/model',
          system: 'PRIVATE_SYSTEM_PROMPT',
          input: 'PRIVATE_SCENARIO',
          signal: AbortSignal.timeout(2000),
          stage: 'evaluator',
        },
      );
      telemetry.recordScore({ name: 'quality', value: 0.5 });
      await telemetry.finish(false);
      reportFailure('worker.queue', { runId, agentId, jobId });
      await flushTelemetry();
      expect(calls).toEqual([]);
      expect(getTestSpans()).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('run spans', () => {
  test('emits correlated run, model, policy and budget spans without private payloads', async () => {
    installTestTelemetry();
    const telemetry = createRunTelemetry({
      runId,
      agentId,
      configurationId,
      version: 3,
      jobId,
      lifecycle: 'shadow',
    });
    await telemetry.callModel(
      async () => ({
        decision: { relevant: true, reason: 'PRIVATE_RESULT', priority: 0.4, actions: [] },
        inputTokens: 10,
        outputTokens: 5,
        costMicros: 2500,
      }),
      {
        model: 'test/model',
        system: 'PRIVATE_SYSTEM_PROMPT',
        input: 'PRIVATE_SCENARIO',
        signal: AbortSignal.timeout(2000),
        stage: 'evaluator',
      },
    );
    await withOrbitSpan(
      'orbit.policy',
      { tool: 'reply', stage: 'main', policy_decision: 'suppressed', run_id: runId, agent_id: agentId },
      async () => 'ok',
    );
    await withOrbitSpan(
      'orbit.budget',
      { stage: 'evaluator', budget_violation: 'daily-requests', run_id: runId },
      async () => 'ok',
    );
    recordLangfuseScore({ name: 'quality', value: 0.9 });
    await telemetry.finish(false);
    await flushTelemetry();

    const serialized = JSON.stringify(getTestSpans().map((span) => ({
      name: span.name,
      attributes: span.attributes,
    })));
    expect(serialized).toContain('orbit.run');
    expect(serialized).toContain('orbit.evaluator');
    expect(serialized).toContain('orbit.policy');
    expect(serialized).toContain('orbit.budget');
    expect(serialized).toContain(runId);
    expect(serialized).toContain(agentId);
    expect(serialized).toContain(jobId);
    expect(serialized).toContain('test/model');
    expect(serialized).toContain('0.0025');
    expect(serialized).not.toMatch(/PRIVATE_|sk-or-|Bearer /);
  });
});
