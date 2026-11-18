import { context, ROOT_CONTEXT, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import type { TelemetryOptions } from 'ai';

import {
  observabilityEnvironment,
  parseObservabilityEnv,
  type ObservabilityEnv,
} from '@/lib/observability/env';
import { reportFailure, type FailureCorrelation } from '@/lib/observability/errors';
import { redactValue, safeOrbitTags } from '@/lib/observability/redact';
import type { ModelCall } from '@/lib/runtime/simulation';

type LangfuseHandle = {
  processor: { forceFlush(): Promise<void>; shutdown(): Promise<void> };
  client: { flush(): Promise<void>; shutdown(): Promise<void>; score: { activeTrace(data: ScoreInput): void } };
};

type ScoreInput = {
  name: string;
  value: number;
  dataType?: 'NUMERIC' | 'BOOLEAN' | 'CATEGORICAL';
  comment?: string;
};

let testExporter: InMemorySpanExporter | undefined;
let testProvider: BasicTracerProvider | undefined;
let langfuse: LangfuseHandle | undefined;
let langfuseInitAttempted = false;

function observability(): ObservabilityEnv {
  return parseObservabilityEnv(process.env);
}

function swallow(label: string, _error?: unknown) {
  console.warn(label);
}

function isLangfuseEnabled() {
  return testExporter !== undefined || observability().langfuse !== undefined;
}

async function ensureLangfuse() {
  if (testProvider) return;
  if (langfuseInitAttempted) return;
  langfuseInitAttempted = true;
  const config = observability().langfuse;
  if (!config) return;
  try {
    const [{ LangfuseSpanProcessor }, { setLangfuseTracerProvider }, { LangfuseClient }] =
      await Promise.all([
        import('@langfuse/otel'),
        import('@langfuse/tracing'),
        import('@langfuse/client'),
      ]);
    const processor = new LangfuseSpanProcessor({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
      environment: observabilityEnvironment(),
      mediaUploadEnabled: false,
      timeout: 3,
      exportMode: 'batched',
      mask: ({ data }: { data: unknown }) =>
        redactValue(data, { captureContent: config.captureContent }),
      shouldExportSpan: () => true,
    });
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    setLangfuseTracerProvider(provider);
    const client = new LangfuseClient({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
      timeout: 3,
    });
    langfuse = { processor, client };
  } catch (error) {
    swallow('Langfuse exporter setup failed', error);
    langfuse = undefined;
  }
}

async function getTracer(): Promise<Tracer | undefined> {
  if (testProvider) return testProvider.getTracer('orbit');
  await ensureLangfuse();
  if (!isLangfuseEnabled()) return;
  try {
    const { getLangfuseTracer } = await import('@langfuse/tracing');
    return getLangfuseTracer();
  } catch (error) {
    swallow('Langfuse tracer is unavailable', error);
  }
}

export function installTestTelemetry() {
  testExporter = new InMemorySpanExporter();
  testProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(testExporter)],
  });
  return testExporter;
}

export function getTestSpans(): ReadableSpan[] {
  return testExporter?.getFinishedSpans() ?? [];
}

export async function resetTestTelemetry() {
  try {
    await testProvider?.forceFlush();
  } catch (error) {
    swallow('Test tracer flush failed', error);
  }
  try {
    await testProvider?.shutdown();
  } catch {
    // Provider shutdown is best-effort in tests.
  }
  testExporter?.reset();
  testExporter = undefined;
  testProvider = undefined;
  langfuse = undefined;
  langfuseInitAttempted = false;
  try {
    const { setLangfuseTracerProvider } = await import('@langfuse/tracing');
    setLangfuseTracerProvider(null);
  } catch {
    // Tracing package may be unused on the disabled path.
  }
}

export async function withOrbitSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = await getTracer();
  if (!tracer) return fn();
  const span = tracer.startSpan(name, { attributes: safeOrbitTags(attributes) }, context.active());
  try {
    return await context.with(trace.setSpan(context.active(), span), fn);
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'failed' });
    throw error;
  } finally {
    span.end();
  }
}

async function aiSdkTelemetry(functionId: string): Promise<TelemetryOptions | undefined> {
  if (!isLangfuseEnabled()) return { isEnabled: false };
  const captureContent = observability().langfuse?.captureContent === true;
  try {
    const { LangfuseVercelAiSdkIntegration } = await import('@langfuse/vercel-ai-sdk');
    const tracer = await getTracer();
    return {
      isEnabled: true,
      recordInputs: captureContent,
      recordOutputs: captureContent,
      functionId,
      integrations: [new LangfuseVercelAiSdkIntegration(tracer ? { tracer } : undefined)],
    };
  } catch (error) {
    swallow('Langfuse AI SDK integration failed', error);
    return {
      isEnabled: true,
      recordInputs: captureContent,
      recordOutputs: captureContent,
      functionId,
    };
  }
}

export type RunTelemetryContext = {
  runId: string;
  agentId: string;
  configurationId: string;
  version: number;
  jobId?: string;
  lifecycle?: string;
  trigger?: string;
};

export function createRunTelemetry(run: RunTelemetryContext) {
  const tags = safeOrbitTags({
    agent_id: run.agentId,
    run_id: run.runId,
    job_id: run.jobId,
    configuration_id: run.configurationId,
    configuration_version: run.version,
    lifecycle: run.lifecycle,
    trigger: run.trigger ?? 'playground',
    environment: observabilityEnvironment(),
  });
  const correlation: FailureCorrelation = {
    agentId: run.agentId,
    runId: run.runId,
    jobId: run.jobId,
    lifecycle: run.lifecycle,
  };

  let root = undefined as ReturnType<Tracer['startSpan']> | undefined;
  let traceId: string | undefined;
  const ready = (async () => {
    const tracer = await getTracer();
    if (!tracer) return;
    try {
      root = tracer.startSpan(
        'orbit.run',
        {
          attributes: {
            ...tags,
            'langfuse.observation.type': 'agent',
            'langfuse.trace.name': 'orbit.run',
            'langfuse.environment': observabilityEnvironment(),
          },
        },
        ROOT_CONTEXT,
      );
      traceId = root.spanContext().traceId;
    } catch (error) {
      swallow('Langfuse run span failed', error);
    }
  })();

  const inRunContext = async <T>(fn: () => Promise<T>) => {
    await ready;
    if (!root) return fn();
    const parent = trace.setSpan(ROOT_CONTEXT, root);
    try {
      const { propagateAttributes } = await import('@langfuse/tracing');
      return await context.with(parent, () =>
        propagateAttributes(
          {
            sessionId: run.runId,
            userId: run.agentId,
            traceName: 'orbit.run',
            version: String(run.version),
            tags: ['orbit', run.trigger ?? 'playground', observabilityEnvironment()],
            metadata: tags,
          },
          fn,
        ),
      );
    } catch {
      return await context.with(parent, fn);
    }
  };

  const callModel = async (call: ModelCall, request: Parameters<ModelCall>[0]) => {
    const start = performance.now();
    const stage = request.stage ?? 'main';
    return await inRunContext(async () => {
      const tracer = await getTracer();
      const span = tracer?.startSpan(
        `orbit.${stage}`,
        {
          attributes: {
            ...safeOrbitTags({ stage, agent_id: run.agentId, run_id: run.runId }),
            'langfuse.observation.type': stage === 'evaluator' ? 'evaluator' : 'generation',
            ...(/^[\w.-]+\/[\w.:-]+$/.test(request.model)
              ? { 'langfuse.observation.model.name': request.model }
              : {}),
          },
        },
        context.active(),
      );
      try {
        const telemetry = await aiSdkTelemetry(`orbit.${stage}`);
        const response = await context.with(
          span ? trace.setSpan(context.active(), span) : context.active(),
          () => call({ ...request, telemetry }),
        );
        span?.setAttribute('orbit.duration_ms', Math.round(performance.now() - start));
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
        recordLangfuseScore({
          name: stage === 'evaluator' ? 'relevance' : 'completed',
          value: response.decision.relevant ? 1 : 0,
          dataType: 'BOOLEAN',
        });
        if (stage === 'evaluator') {
          recordLangfuseScore({
            name: 'priority',
            value: response.decision.priority,
            dataType: 'NUMERIC',
          });
        }
        return response;
      } catch (error) {
        span?.setStatus({ code: SpanStatusCode.ERROR, message: 'Inference failed' });
        if (!request.signal.aborted) {
          reportFailure(
            'worker.inference',
            { ...correlation, stage, traceId },
            error,
          );
        }
        throw error;
      } finally {
        span?.end();
      }
    });
  };

  return {
    get traceId() {
      return traceId;
    },
    callModel,
    recordScore: (score: ScoreInput) => {
      recordLangfuseScore(score);
    },
    finish: async (failed: boolean) => {
      try {
        await ready;
        if (failed) root?.setStatus({ code: SpanStatusCode.ERROR, message: 'Run did not complete' });
        root?.end();
      } catch (error) {
        swallow('Langfuse run span finish failed', error);
      }
    },
  };
}

export function recordLangfuseScore(score: ScoreInput) {
  if (!isLangfuseEnabled()) return;
  const name = score.name.trim().slice(0, 80);
  if (!/^[a-zA-Z][\w.-]{0,79}$/.test(name) || !Number.isFinite(score.value)) return;
  try {
    const span = trace.getActiveSpan();
    span?.setAttribute(`langfuse.score.${name}`, score.value);
    langfuse?.client.score.activeTrace({
      name,
      value: score.value,
      dataType: score.dataType ?? 'NUMERIC',
      comment: score.comment ? String(redactValue(score.comment, { captureContent: false })) : undefined,
    });
  } catch (error) {
    swallow('Langfuse score failed', error);
  }
}

export async function flushTelemetry() {
  try {
    await testProvider?.forceFlush();
  } catch (error) {
    swallow('Test tracer flush failed', error);
  }
  if (!langfuse) return;
  try {
    await Promise.all([langfuse.processor.forceFlush(), langfuse.client.flush()]);
  } catch (error) {
    swallow('Observability flush failed', error);
  }
}

export async function shutdownTelemetry() {
  await flushTelemetry();
  try {
    await langfuse?.processor.shutdown();
    await langfuse?.client.shutdown();
  } catch (error) {
    swallow('Observability shutdown failed', error);
  }
  langfuse = undefined;
  langfuseInitAttempted = false;
}
