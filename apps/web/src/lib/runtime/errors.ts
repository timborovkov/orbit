import { isBudgetError } from '@/lib/budgets';

export class MissingOpenRouterCredentialError extends Error {
  constructor() {
    super('Missing OpenRouter credential');
    this.name = 'MissingOpenRouterCredentialError';
  }
}

/**
 * Transient store/network failures that should return the job to the queue for retry
 * instead of being persisted as a terminal simulation failure.
 */
export class RetryableInfrastructureError extends Error {
  constructor(message = 'Transient infrastructure failure; the job will retry.') {
    super(message);
    this.name = 'RetryableInfrastructureError';
  }
}

/**
 * Retryable failure that is known to have occurred before any provider request.
 * Safe to release a simulation step reservation and retry the stage.
 */
export class PreDispatchInfrastructureError extends RetryableInfrastructureError {
  constructor(
    message = 'Transient infrastructure failure before provider dispatch; the job will retry.',
  ) {
    super(message);
    this.name = 'PreDispatchInfrastructureError';
  }
}

/** Shared burn message when a paid model response cannot be made durable. */
export const PAID_STEP_BURN_MESSAGE =
  'A previous attempt already used this model step but could not save the result. Start a new run.';

/**
 * Provider already returned a paid response but the dispatch burn could not be persisted.
 * Not retryable — the queue must not redo the stage.
 */
export class PaidStepUnpersistedError extends Error {
  readonly stage: 'evaluator' | 'main';

  constructor(stage: 'evaluator' | 'main') {
    super(PAID_STEP_BURN_MESSAGE);
    this.name = 'PaidStepUnpersistedError';
    this.stage = stage;
  }
}

export function isRetryableInfrastructureError(
  error: unknown,
): error is RetryableInfrastructureError {
  return error instanceof RetryableInfrastructureError;
}

export function isPreDispatchInfrastructureError(
  error: unknown,
): error is PreDispatchInfrastructureError {
  return error instanceof PreDispatchInfrastructureError;
}

export function isPaidStepUnpersistedError(error: unknown): error is PaidStepUnpersistedError {
  return error instanceof PaidStepUnpersistedError;
}

/**
 * A paid step could not be burned durably and must not be ordinary-retried (that would
 * redispatch). The worker should force-dead-letter the job instead of failJob backoff.
 */
export class UnrecoverablePaidStepFinalizationError extends Error {
  constructor(message = PAID_STEP_BURN_MESSAGE) {
    super(message);
    this.name = 'UnrecoverablePaidStepFinalizationError';
  }
}

export function isUnrecoverablePaidStepFinalizationError(
  error: unknown,
): error is UnrecoverablePaidStepFinalizationError {
  return error instanceof UnrecoverablePaidStepFinalizationError;
}

/** Classify unexpected store failures as retryable without wrapping budget/retryable errors. */
export async function retryableStore<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    if (isBudgetError(error) || isRetryableInfrastructureError(error)) throw error;
    throw new RetryableInfrastructureError();
  }
}
