import { and, eq, lt, sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import { openRouterInference } from '@/lib/runtime/openrouter';
import { resolveOpenRouterApiKey } from '@/lib/runtime/openrouter-key';
import { simulate, type ModelCall } from '@/lib/runtime/simulation';
import { agents, configurations, credentials, runs } from '@/lib/schema';

// Authentication belongs to the caller (admin action today, durable worker later).
// Inference injection lets tests exercise persistence without spending provider credit.
export async function executeSimulation(
  {
    actor,
    agentId,
    configurationId,
    input,
  }: {
    actor: string;
    agentId: string;
    configurationId: string;
    input: string;
  },
  inference: (key: string) => ModelCall = openRouterInference,
) {
  const claimed = await db().transaction(async (tx) => {
    await tx.select().from(agents).where(eq(agents.id, agentId)).for('update');
    await tx
      .update(runs)
      .set({ status: 'interrupted', finishedAt: new Date() })
      .where(
        and(eq(runs.agentId, agentId), eq(runs.status, 'running'), lt(runs.expiresAt, new Date())),
      );
    const active = (
      await tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.agentId, agentId), eq(runs.status, 'running')))
    ).at(0);
    if (active) return null;
    const config = (
      await tx
        .select()
        .from(configurations)
        .where(and(eq(configurations.id, configurationId), eq(configurations.agentId, agentId)))
    ).at(0);
    if (!config) return null;
    const run = (
      await tx
        .insert(runs)
        .values({
          agentId,
          configurationId,
          input: input,
          actor,
          result: { steps: [], actions: [], error: null },
          expiresAt: new Date(Date.now() + 150000),
        })
        .returning()
    ).at(0);
    if (!run) throw new Error('Run insert failed');
    return { config, run };
  });
  if (!claimed)
    return {
      error:
        'A run is already in progress or the configuration is unavailable. Refresh and try again.',
    };
  const { config, run } = claimed;
  try {
    const credential = (
      await db().select().from(credentials).where(eq(credentials.agentId, agentId))
    ).at(0);
    const { apiKey } = resolveOpenRouterApiKey(agentId, credential?.encryptedKey);
    const call = inference(apiKey);
    const result = await simulate(config.config, input, call, async (result) => {
      await db().update(runs).set({ result }).where(eq(runs.id, run.id));
    });
    await db()
      .update(runs)
      .set({ status: result.error ? 'failed' : 'completed', finishedAt: new Date(), result })
      .where(eq(runs.id, run.id));
  } catch {
    await db()
      .update(runs)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        result: sql`jsonb_set(${runs.result}, '{error}', to_jsonb(${'Unable to complete inference. Check the agent credential or OPENROUTER_API_KEY, server encryption key and provider availability, then try again.'}::text))`,
      })
      .where(eq(runs.id, run.id));
  }
  return { message: 'Run saved. Inspect its decisions and drafts in run history.' };
}
