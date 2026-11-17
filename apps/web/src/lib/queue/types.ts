export const jobStatuses = [
  'pending',
  'claimed',
  'completed',
  'failed',
  'dead',
  'cancelled',
] as const;
export type JobStatus = (typeof jobStatuses)[number];

export type JobRecord = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  claimedAt: Date | null;
  claimExpiresAt: Date | null;
  claimedBy: string | null;
  finishedAt: Date | null;
  lastError: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type EnqueueInput = {
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string | null;
  availableAt?: Date;
  maxAttempts?: number;
};

export type ClaimOptions = {
  workerId: string;
  types?: string[];
  leaseMs?: number;
  limit?: number;
};

export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_POLL_MS = 1_000;
export const DEFAULT_RECOVERY_MS = 5_000;

export function backoffMs(attempts: number): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}
