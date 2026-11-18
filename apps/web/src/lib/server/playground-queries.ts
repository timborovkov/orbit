import 'server-only';

import { eq } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { runs } from '@/lib/schema';

/** Authorized lookup of a simulation run for playground stream polling. */
export async function getSimulationRun(runId: string) {
  await requireAdmin();
  return (await db().select().from(runs).where(eq(runs.id, runId))).at(0) ?? null;
}
