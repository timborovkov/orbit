import type { Db, Tx } from '@/lib/db';

export interface SeedContext {
  db: Db;
  tx: Tx;
  now: Date;
  reset: boolean;
  encryptionKeyConfigured: boolean;
  /** Explicit opt-in: release the workspace-wide global outbound pause. */
  releaseGlobalPause: boolean;
}

export interface SeedModule {
  /** Stable feature-area name for logging and registry order. */
  name: string;
  /**
   * Apply this module inside an open transaction.
   * Must be idempotent: running twice without reset yields the same logical state.
   */
  apply(ctx: SeedContext): Promise<void>;
}
