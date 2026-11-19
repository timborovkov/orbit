import 'server-only';

import { eq } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { budgetViolationMessage } from '@/lib/budgets';
import { db } from '@/lib/db';
import {
  isExpiredSimulationRun,
  watchSimulationRunWithLookup,
} from '@/lib/runtime/simulation-watch';
import { runs } from '@/lib/schema';

/** Authorized lookup of a simulation run for playground stream polling. */
async function getSimulationRun(runId: string) {
  await requireAdmin();
  const rows = await db()
    .select({
      id: runs.id,
      status: runs.status,
      result: runs.result,
      deferReason: runs.deferReason,
      expiresAt: runs.expiresAt,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  const run = rows.at(0);
  if (!run) return null;
  // Only mid-flight running past deadline; queued waits for claim (fresh deadline).
  if (isExpiredSimulationRun(run)) {
    return {
      ...run,
      status: 'interrupted' as const,
      deferReason: budgetViolationMessage('run-deadline'),
    };
  }
  return run;
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
