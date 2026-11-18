import 'server-only';

import { eq } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { watchSimulationRunWithLookup } from '@/lib/runtime/simulation-watch';
import { runs } from '@/lib/schema';

async function lookupSimulationRunById(runId: string) {
  return (await db().select().from(runs).where(eq(runs.id, runId))).at(0) ?? null;
}

/** Authorized lookup of a simulation run for playground stream polling. */
async function getSimulationRun(runId: string) {
  await requireAdmin();
  return lookupSimulationRunById(runId);
}

interface WatchOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Authorized poll of a simulation run for the playground stream adapter. */
export async function* watchSimulationRun(runId: string, options: WatchOptions = {}) {
  yield* watchSimulationRunWithLookup(getSimulationRun, runId, options);
}
