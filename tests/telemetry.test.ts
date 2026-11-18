import { expect, test } from 'bun:test';

import { createRunTelemetry, flushTelemetry, reportFailure } from '@/lib/runtime/telemetry';

test('telemetry correlates both model stages with the run and omits private payloads', async () => {
  const captures: { path: string; body: string }[] = [];
  const sink = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      captures.push({ path: new URL(request.url).pathname, body: await request.text() });
      return Response.json({});
    },
  });
  const configuration = {
    LANGFUSE_PUBLIC_KEY: 'synthetic-trace-public',
    LANGFUSE_SECRET_KEY: 'synthetic-trace-secret',
    LANGFUSE_BASE_URL: sink.url.href,
    SENTRY_DSN: `http://synthetic-sentry@127.0.0.1:${sink.port}/10`,
  };
  const previous = Object.entries(configuration).map(([key, value]) => {
    const old = process.env[key];
    process.env[key] = value;
    return [key, old] as const;
  });
  const runId = 'b5357382-f3e5-45af-bbd2-0557ae15c534';
  try {
    const telemetry = createRunTelemetry({
      runId,
      agentId: '59ba5d9b-ad62-4324-8669-8bc33edf3a6d',
      configurationId: '5eef28f6-3f4e-4242-9218-e68345374052',
      version: 1,
    });
    const request = {
      model: 'test/model',
      system: 'PRIVATE_SYSTEM_PROMPT',
      input: 'PRIVATE_SCENARIO',
      signal: AbortSignal.timeout(2000),
    };
    await telemetry.callModel(
      async () => ({
        decision: { relevant: true, reason: 'PRIVATE_RESULT', priority: 1, actions: [] },
        inputTokens: 10,
        outputTokens: 5,
      }),
      { ...request, stage: 'evaluator' },
    );
    await expect(
      telemetry.callModel(
        async () => {
          throw new Error('PRIVATE_PROVIDER_ERROR');
        },
        { ...request, stage: 'main' },
      ),
    ).rejects.toThrow('PRIVATE_PROVIDER_ERROR');
    telemetry.finish(true);
    await reportFailure('web.request');
    await flushTelemetry();

    const trace = captures.find((entry) => entry.path.includes('otel/v1/traces'));
    expect(trace?.body).toContain('OpenRouter evaluator');
    expect(trace?.body).toContain('OpenRouter main');
    expect(trace?.body).toContain(runId);
    const workerEvent = captures.find((entry) =>
      entry.body.includes('Orbit model inference failed'),
    );
    expect(workerEvent?.body).toContain(runId);
    expect(workerEvent?.body).toContain(telemetry.traceId!);
    expect(captures.some((entry) => entry.body.includes('Orbit web request failed'))).toBeTrue();
    expect(captures.map((entry) => entry.body).join('')).not.toMatch(
      /PRIVATE_|synthetic-trace-secret/,
    );
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await sink.stop(true);
  }
});
