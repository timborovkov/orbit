import { context, ROOT_CONTEXT, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import type { TelemetryOptions } from 'ai';

import { isBudgetError } from '@/lib/budgets';
import {
  observabilityEnvironment,
  parseObservabilityEnv,
  type ObservabilityEnv,
} from '@/lib/observability/env';
import { reportFailure, type FailureCorrelation } from '@/lib/observability/errors';
import {
  applyOpenRouterCostToSpan,
  langfuseBlockedStatus,
  langfuseMetadataAttributes,
} from '@/lib/observability/langfuse-attributes';
import { redactValue, safeOrbitTags } from '@/lib/observability/redact';
import {
  isPaidStepUnpersistedError,
  isUnrecoverablePaidStepFinalizationError,
} from '@/lib/runtime/errors';
import type { ModelCall } from '@/lib/runtime/simulation';

interface LangfuseHandle {
  processor: { forceFlush(): Promise<void>; shutdown(): Promise<void> };
  client: {
    flush(): Promise<void>;
    shutdown(): Promise<void>;
    score: { activeTrace(data: ScoreInput): void };
  };
}

interface ScoreInput {
  name: string;
  value: number;
  dataType?: 'NUMERIC' | 'BOOLEAN' | 'CATEGORICAL';
  comment?: string;
}

let testExporter: InMemorySpanExporter | undefined;
let testProvider: BasicTracerProvider | undefined;
let langfuse: LangfuseHandle | undefined;
let langfuseInitAttempted = false;
let telemetryContextReady = false;

/** Install async context so Langfuse works without Sentry. Idempotent if Sentry already registered. */
export function ensureTelemetryContext() {
  if (telemetryContextReady) return;
  if (!testProvider && !observability().langfuse) return;
  try {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  } catch (error) {
    swallow('OpenTelemetry context manager setup failed', error);
  }
  telemetryContextReady = true;
}

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
  ensureTelemetryContext();
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
  ensureTelemetryContext();
  return testExporter;
}

/** Verify `context.with` parents child spans when Sentry is not initialized. */
export async function parentSpanViaActiveContext() {
  ensureTelemetryContext();
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  try {
    const tracer = provider.getTracer('orbit');
    const parent = tracer.startSpan('orbit.context.parent', {}, ROOT_CONTEXT);
    context.with(trace.setSpan(ROOT_CONTEXT, parent), () => {
      tracer.startSpan('orbit.context.child', {}, context.active()).end();
    });
    parent.end();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const parentSpan = spans.find((span) => span.name === 'orbit.context.parent');
    const childSpan = spans.find((span) => span.name === 'orbit.context.child');
    return {
      parentId: parentSpan?.spanContext().spanId,
      childParentId: childSpan?.parentSpanContext?.spanId,
    };
  } finally {
    await provider.shutdown();
  }
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

async function aiSdkTelemetry(
  functionId: string,
  allowContentCapture: boolean,
): Promise<TelemetryOptions | undefined> {
  if (!isLangfuseEnabled()) return { isEnabled: false };
  const captureContent = allowContentCapture && observability().langfuse?.captureContent === true;
  try {
    const { LangfuseVercelAiSdkIntegration } = await import('@langfuse/vercel-ai-sdk');
    const tracer = await getTracer();
    const integration = new LangfuseVercelAiSdkIntegration(tracer ? { tracer } : undefined);
    const executeLanguageModelCall = integration.executeLanguageModelCall.bind(integration);
    integration.executeLanguageModelCall = ({ callId, execute }) =>
      executeLanguageModelCall({
        callId,
        execute: async () => {
          const result = await execute();
          applyOpenRouterCostToSpan(trace.getActiveSpan(), result);
          return result;
        },
      });
    return {
      isEnabled: true,
      recordInputs: captureContent,
      recordOutputs: captureContent,
      functionId,
      integrations: [integration],
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

function applyBlockedStatus(
  span: {
    setAttribute(key: string, value: string): void;
    setStatus(status: { code: number; message?: string }): void;
  },
  status: { level: 'WARNING' | 'ERROR'; message: string } | undefined,
) {
  if (!status) return;
  span.setAttribute('langfuse.observation.level', status.level);
  span.setAttribute('langfuse.observation.status_message', status.message);
  if (status.level === 'ERROR') {
    span.setStatus({ code: SpanStatusCode.ERROR, message: status.message });
  }
}

export interface RunTelemetryContext {
  runId: string;
  agentId: string;
  configurationId: string;
  version: number;
  jobId?: string;
  lifecycle?: string;
  trigger?: string;
  allowContentCapture?: boolean;
}

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
            ...langfuseMetadataAttributes(tags, 'both'),
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

  const runContext = () => (root ? trace.setSpan(ROOT_CONTEXT, root) : context.active());

  const inRunContext = async <T>(fn: () => Promise<T>) => {
    await ready;
    if (!root) return fn();
    const parent = runContext();
    let runFn = fn;
    try {
      const { propagateAttributes } = await import('@langfuse/tracing');
      runFn = () =>
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
        );
    } catch (error) {
      swallow('Langfuse attribute propagation failed', error);
    }
    return await context.with(parent, runFn);
  };

  const withSpan = async <T>(
    name: string,
    attributes: Record<string, string | number | boolean | undefined>,
    fn: () => Promise<T> | T,
  ): Promise<T> => {
    await ready;
    const tracer = await getTracer();
    if (!tracer) return await fn();
    const parent = runContext();
    const tags = safeOrbitTags(attributes);
    const span = tracer.startSpan(
      name,
      {
        attributes: {
          ...tags,
          ...langfuseMetadataAttributes(tags),
        },
      },
      parent,
    );
    applyBlockedStatus(span, langfuseBlockedStatus(attributes));
    try {
      const result = await context.with(trace.setSpan(parent, span), async () => await fn());
      applyBlockedStatus(span, langfuseBlockedStatus(attributes, result));
      return result;
    } catch (error) {
      if (isBudgetError(error)) {
        const message = `budget:${error.kind}`;
        span.setAttribute('langfuse.observation.level', 'ERROR');
        span.setAttribute('langfuse.observation.status_message', message);
        span.setAttributes(langfuseMetadataAttributes({ 'orbit.budget_violation': error.kind }));
        span.setStatus({ code: SpanStatusCode.ERROR, message });
      } else if (
        isPaidStepUnpersistedError(error) ||
        isUnrecoverablePaidStepFinalizationError(error)
      ) {
        const message = isUnrecoverablePaidStepFinalizationError(error)
          ? 'force-dead-letter'
          : 'paid-step-burn';
        span.setAttribute('langfuse.observation.level', 'ERROR');
        span.setAttribute('langfuse.observation.status_message', message);
        span.setAttributes(langfuseMetadataAttributes({ 'orbit.outcome': message }));
        span.setStatus({ code: SpanStatusCode.ERROR, message });
      } else {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'failed' });
      }
      throw error;
    } finally {
      span.end();
    }
  };

  const callModel = async (call: ModelCall, request: Parameters<ModelCall>[0]) => {
    const start = performance.now();
    const stage = request.stage ?? 'main';
    return await inRunContext(async () => {
      const tracer = await getTracer();
      const modelTags = safeOrbitTags({ stage, agent_id: run.agentId, run_id: run.runId });
      const span = tracer?.startSpan(
        `orbit.${stage}`,
        {
          attributes: {
            ...modelTags,
            ...langfuseMetadataAttributes(modelTags),
            'langfuse.observation.type': 'span',
            ...(/^[\w.-]+\/[\w.:-]+$/.test(request.model)
              ? { 'langfuse.observation.model.name': request.model }
              : {}),
          },
        },
        runContext(),
      );
      try {
        const telemetry = await aiSdkTelemetry(`orbit.${stage}`, run.allowContentCapture !== false);
        const response = await context.with(
          span ? trace.setSpan(context.active(), span) : context.active(),
          () => call({ ...request, telemetry }),
        );
        span?.setAttribute('orbit.duration_ms', Math.round(performance.now() - start));
        span?.setAttribute('orbit.input_tokens', response.inputTokens);
        span?.setAttribute('orbit.output_tokens', response.outputTokens);
        span?.setAttributes(
          langfuseMetadataAttributes({
            'orbit.input_tokens': response.inputTokens,
            'orbit.output_tokens': response.outputTokens,
            ...(response.costMicros === undefined
              ? {}
              : { 'orbit.cost_usd': response.costMicros / 1_000_000 }),
          }),
        );
        if (response.costMicros !== undefined) {
          span?.setAttribute('orbit.cost_usd', response.costMicros / 1_000_000);
        }
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
          reportFailure('worker.inference', { ...correlation, stage, traceId }, error);
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
    inRunContext,
    withSpan,
    callModel,
    recordScore: (score: ScoreInput) => {
      recordLangfuseScore(score);
    },
    finish: async (failed: boolean, statusMessage?: string) => {
      try {
        await ready;
        if (failed) {
          const message = statusMessage ?? 'Run did not complete';
          root?.setAttribute('langfuse.observation.level', 'ERROR');
          root?.setAttribute('langfuse.observation.status_message', message);
          root?.setStatus({ code: SpanStatusCode.ERROR, message });
        }
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
      comment: score.comment
        ? String(redactValue(score.comment, { captureContent: false }))
        : undefined,
    });
  } catch (error) {
    swallow('Langfuse score failed', error);
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Record an approval decision as a short-lived Langfuse/OTel span when configured.
 * Never includes drafts, payloads, or actor emails. Best-effort and non-blocking.
 */
export function recordApprovalDecision(input: {
  intentId: string;
  agentId: string;
  runId?: string | null;
  decision: 'approved' | 'rejected';
}) {
  if (!uuid.test(input.intentId) || !uuid.test(input.agentId)) return;
  void (async () => {
    try {
      const tracer = await getTracer();
      if (!tracer) return;
      const tags = safeOrbitTags({
        'orbit.approval.decision': input.decision,
        'orbit.intent_id': input.intentId,
        'orbit.agent_id': input.agentId,
        ...(input.runId && uuid.test(input.runId) ? { 'orbit.run_id': input.runId } : {}),
      });
      const span = tracer.startSpan(
        'orbit.approval.decision',
        {
          attributes: {
            ...tags,
            ...langfuseMetadataAttributes(tags),
            'langfuse.observation.type': 'event',
          },
        },
        ROOT_CONTEXT,
      );
      span.end();
    } catch (error) {
      swallow('Langfuse approval decision span failed', error);
    }
  })();
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
