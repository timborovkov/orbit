import { isBudgetError } from '@/lib/budgets';

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

export function isRetryableInfrastructureError(
  error: unknown,
): error is RetryableInfrastructureError {
  return error instanceof RetryableInfrastructureError;
}

/** Classify unexpected store failures as retryable without wrapping budget/retryable errors. */
export async function retryableStore<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    if (isBudgetError(error) || isRetryableInfrastructureError(error)) throw error;
    throw new RetryableInfrastructureError(
      error instanceof Error ? error.message : 'Transient infrastructure failure',
    );
  }
}
