import { randomUUID } from 'node:crypto';
import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

import type { ModelCall } from '@/lib/runtime/simulation';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function endpoint(value: string) {
  try {
    const url = new URL(value);
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (url.protocol === 'https:' || (local && url.protocol === 'http:')) return url;
  } catch {
    return undefined;
  }
}

let tracerProvider: BasicTracerProvider | undefined;
function getTracer() {
  const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL } = process.env;
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) return;
  const host = LANGFUSE_BASE_URL?.trim();
  const url = endpoint(host?.length ? host : 'https://cloud.langfuse.com');
  if (!url || url.username || url.password || url.search || url.hash) return;
  tracerProvider ??= new BasicTracerProvider({
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: `${url.href.replace(/\/$/, '')}/api/public/otel/v1/traces`,
          headers: {
            Authorization: `Basic ${Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString('base64')}`,
          },
          timeoutMillis: 3000,
        }),
        { exportTimeoutMillis: 3000 },
      ),
    ],
  });
  return tracerProvider.getTracer('orbit');
}

const operations = {
  'web.request': 'Orbit web request failed',
  'worker.queue': 'Orbit worker queue operation failed',
  'worker.inference': 'Orbit model inference failed',
  'worker.settlement': 'Orbit inference cost settlement failed',
} as const;

export async function reportFailure(
  operation: keyof typeof operations,
  correlation: {
    runId?: string;
    traceId?: string;
    stage?: 'evaluator' | 'main';
    durationMs?: number;
  } = {},
) {
  const dsn = process.env.SENTRY_DSN && endpoint(process.env.SENTRY_DSN);
  if (!dsn || !/^[\w-]+$/.test(dsn.username) || dsn.password || dsn.search || dsn.hash) return;
  const path = dsn.pathname.split('/').filter(Boolean);
  const project = path.pop();
  if (!project || !/^\d+$/.test(project)) return;
  const prefix = path.length ? `/${path.join('/')}` : '';
  const eventId = randomUUID().replaceAll('-', '');
  // Explicit allowlist. No exception, stack, headers, request body, actor, or draft is serialized.
  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: 'javascript',
    level: 'error',
    environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    message: operations[operation],
    tags: {
      'orbit.operation': operation,
      'orbit.run_id':
        correlation.runId && uuid.test(correlation.runId) ? correlation.runId : undefined,
      'orbit.langfuse_trace_id':
        correlation.traceId && /^[0-9a-f]{32}$/.test(correlation.traceId)
          ? correlation.traceId
          : undefined,
      'orbit.stage': correlation.stage,
    },
    extra: { duration_ms: correlation.durationMs },
  };

  try {
    await fetch(`${dsn.origin}${prefix}/api/${project}/envelope/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7,sentry_key=${dsn.username}`,
      },
      body:
        [
          JSON.stringify({ event_id: eventId }),
          JSON.stringify({ type: 'event' }),
          JSON.stringify(event),
        ].join('\n') + '\n',
      redirect: 'error',
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // Telemetry outages must not prevent a run from completing or being retried.
  }
}

export function createRunTelemetry(context: {
  runId: string;
  agentId: string;
  configurationId: string;
  version: number;
}) {
  const tracer = getTracer();
  const root = tracer?.startSpan(
    'Orbit simulation',
    {
      attributes: {
        'langfuse.trace.name': 'Orbit simulation',
        'langfuse.trace.session_id': context.runId,
        'orbit.run_id': context.runId,
        'orbit.agent_id': context.agentId,
        'orbit.configuration_id': context.configurationId,
        'orbit.configuration_version': context.version,
        'orbit.trigger': 'playground',
        'langfuse.environment':
          process.env.NODE_ENV === 'production' ? 'production' : 'development',
      },
    },
    ROOT_CONTEXT,
  );
  const parent = root ? trace.setSpan(ROOT_CONTEXT, root) : ROOT_CONTEXT;
  const traceId = root?.spanContext().traceId;

  const callModel = async (call: ModelCall, request: Parameters<ModelCall>[0]) => {
    const start = performance.now();
    const stage = request.stage ?? 'main';
    const span = tracer?.startSpan(
      `OpenRouter ${stage}`,
      {
        attributes: {
          'langfuse.observation.type': 'generation',
          'langfuse.observation.model.name': /^[\w.-]+\/[\w.:-]+$/.test(request.model)
            ? request.model
            : undefined,
          'orbit.stage': stage,
        },
      },
      parent,
    );
    try {
      const response = await call(request);
      span?.setAttributes({
        'langfuse.observation.usage_details': JSON.stringify({
          input: response.inputTokens,
          output: response.outputTokens,
        }),
        ...(response.costMicros === undefined
          ? {}
          : {
              'langfuse.observation.cost_details': JSON.stringify({
                total: response.costMicros / 1_000_000,
              }),
            }),
      });
      return response;
    } catch (error) {
      span?.setStatus({ code: SpanStatusCode.ERROR, message: 'Inference failed' });
      if (!request.signal.aborted) {
        void reportFailure('worker.inference', {
          runId: context.runId,
          traceId,
          stage,
          durationMs: Math.round(performance.now() - start),
        });
      }
      throw error;
    } finally {
      span?.end();
    }
  };

  return {
    traceId,
    callModel,
    finish: (failed: boolean) => {
      if (failed)
        root?.setStatus({ code: SpanStatusCode.ERROR, message: 'Simulation did not complete' });
      root?.end();
    },
  };
}

export async function flushTelemetry() {
  await tracerProvider?.forceFlush().catch(() => undefined);
}
