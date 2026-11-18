import {
  redactSentryEvent,
  safeOrbitTags,
  sanitizeError,
  type SentryLikeEvent,
} from '@/lib/observability/redact';

const failureOperations = {
  'web.request': 'Orbit web request failed',
  'worker.queue': 'Orbit worker queue operation failed',
  'worker.inference': 'Orbit model inference failed',
  'worker.settlement': 'Orbit inference cost settlement failed',
  'worker.dead_letter': 'Orbit job was dead-lettered',
  'worker.runtime': 'Orbit runtime fault',
} as const;

type FailureOperation = keyof typeof failureOperations;

export interface FailureCorrelation {
  agentId?: string;
  runId?: string;
  jobId?: string;
  lifecycle?: string;
  stage?: 'evaluator' | 'main';
  traceId?: string;
}

type Capture = (event: {
  operation: FailureOperation;
  message: string;
  error?: unknown;
  tags: Record<string, string>;
}) => void;

let capture: Capture | undefined;

export function registerErrorCapture(next: Capture | undefined) {
  capture = next;
}

export function reportFailure(
  operation: FailureOperation,
  correlation: FailureCorrelation = {},
  error?: unknown,
) {
  try {
    capture?.({
      operation,
      message: failureOperations[operation],
      error: error === undefined ? undefined : sanitizeError(error, failureOperations[operation]),
      tags: safeOrbitTags({
        operation,
        agent_id: correlation.agentId,
        run_id: correlation.runId,
        job_id: correlation.jobId,
        lifecycle: correlation.lifecycle,
        stage: correlation.stage,
        langfuse_trace_id: correlation.traceId,
      }),
    });
  } catch {
    console.warn('Orbit error reporter failed');
  }
}

export function sentryBeforeSend<T>(event: T): T {
  return redactSentryEvent(event as SentryLikeEvent) as T;
}
