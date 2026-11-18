import { closeDb, db } from '@/lib/db';
import { assertSafeToSeed } from '@/lib/seed/guards';
import { seedModules } from '@/lib/seed/registry';
import { resetDemoData } from '@/lib/seed/reset';
import type { SeedContext } from '@/lib/seed/types';

export interface RunDemoSeedOptions {
  reset?: boolean;
  allowNonLocal?: boolean;
  /** Opt-in: release the workspace-wide global outbound pause. Off by default. */
  releaseGlobalPause?: boolean;
  now?: Date;
  /** When set, skip env/process lookup (tests). */
  env?: {
    NODE_ENV?: string;
    DATABASE_URL?: string;
    ORBIT_ENCRYPTION_KEY?: string;
  };
}

export interface RunDemoSeedResult {
  modules: string[];
  reset: boolean;
  releaseGlobalPause: boolean;
  agentCount: number;
}

export async function runDemoSeed(options: RunDemoSeedOptions = {}): Promise<RunDemoSeedResult> {
  const env = options.env ?? process.env;
  const safety = assertSafeToSeed({
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    allowNonLocal: options.allowNonLocal === true,
  });
  if (!safety.ok) throw new Error(safety.reason);

  const now = options.now ?? new Date();
  const encryptionKeyConfigured = Boolean(
    env.ORBIT_ENCRYPTION_KEY && /^[a-fA-F0-9]{64}$/.test(env.ORBIT_ENCRYPTION_KEY),
  );
  const releaseGlobalPause = options.releaseGlobalPause === true;

  const database = db();
  try {
    await database.transaction(async (tx) => {
      const ctx: SeedContext = {
        db: database,
        tx,
        now,
        reset: options.reset === true,
        encryptionKeyConfigured,
        releaseGlobalPause,
      };
      if (ctx.reset) await resetDemoData(ctx);
      for (const module of seedModules) {
        await module.apply(ctx);
      }
    });
  } finally {
    await closeDb();
  }

  return {
    modules: seedModules.map((module) => module.name),
    reset: options.reset === true,
    releaseGlobalPause,
    agentCount: 3,
  };
}

export { assertSafeToSeed, isLocalDatabaseUrl } from '@/lib/seed/guards';
export { demoPlanFingerprint } from '@/lib/seed/catalog';
export { listSeedModuleNames } from '@/lib/seed/registry';
export { DEMO_ACTOR, DEMO_AGENTS, DEMO_AGENT_IDS, isDemoAgentId } from '@/lib/seed/ids';
