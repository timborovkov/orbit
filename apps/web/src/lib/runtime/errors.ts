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
