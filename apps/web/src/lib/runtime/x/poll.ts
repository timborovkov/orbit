import { and, desc, eq } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import { canAcceptBackgroundWork } from '@/lib/lifecycle';
import { enqueueJob } from '@/lib/queue/jobs';
import type { JobRecord } from '@/lib/queue/types';
import { configSchema, type AgentConfig } from '@/lib/runtime/config';
import { admitRun } from '@/lib/runtime/execute';
import { createXSearchAdapter } from '@/lib/runtime/x/adapter';
import { compareSnowflake } from '@/lib/runtime/x/fixture';
import {
  X_DISCOVERY_ACTOR,
  X_DISCOVERY_POLL_INTERVAL_MS,
  X_DISCOVERY_POLL_JOB,
  X_PROVIDER,
  type XSearchAdapter,
  type XSearchPost,
} from '@/lib/runtime/x/types';
import { agents, configurations, discoveryCursors, jobs, sourceEvents } from '@/lib/schema';

export interface DiscoveryPollOptions {
  adapter?: XSearchAdapter;
  pollIntervalMs?: number;
  now?: Date;
  /** When true, evaluate newly inserted events via admitRun (shadow proposals). */
  evaluate?: boolean;
}

export interface DiscoveryPollResult {
  status: string;
  inserted: number;
  evaluated: number;
  sinceId: string | null;
  /** When set, the worker should defer the same job until this time. */
  deferUntil?: Date;
  error?: string;
}

function readConfig(raw: unknown): AgentConfig {
  return configSchema.parse(raw);
}

export function formatDiscoveryInput(post: XSearchPost): string {
  const author = post.authorUsername
    ? `@${post.authorUsername}`
    : post.authorId
      ? `id:${post.authorId}`
      : 'unknown';
  return `X discovery post ${post.id} by ${author}:\n${post.text}`;
}

function discoveryPollIdempotencyKey(agentId: string): string {
  return `x.discovery.poll:${agentId}`;
}

function mapJob(row: typeof jobs.$inferSelect): JobRecord {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    status: row.status as JobRecord['status'],
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    availableAt: row.availableAt,
    claimedAt: row.claimedAt,
    claimExpiresAt: row.claimExpiresAt,
    claimedBy: row.claimedBy,
    finishedAt: row.finishedAt,
    lastError: row.lastError,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Ensure a durable recurring poll job exists for the agent. Clears a terminal
 * job's idempotency key so resume/config-save can start a fresh poller.
 */
export async function ensureDiscoveryPollJob(
  agentId: string,
  store: Tx | ReturnType<typeof db> = db(),
  availableAt = new Date(),
): Promise<JobRecord> {
  const key = discoveryPollIdempotencyKey(agentId);
  const existing = (
    await store.select().from(jobs).where(eq(jobs.idempotencyKey, key)).limit(1)
  ).at(0);
  if (existing && (existing.status === 'pending' || existing.status === 'claimed')) {
    return mapJob(existing);
  }
  if (existing) {
    await store.update(jobs).set({ idempotencyKey: null }).where(eq(jobs.id, existing.id));
  }
  return enqueueJob(store, {
    type: X_DISCOVERY_POLL_JOB,
    payload: { agentId },
    idempotencyKey: key,
    availableAt,
    maxAttempts: 20,
  });
}

async function upsertCursor(
  tx: Tx,
  agentId: string,
  values: {
    sinceId: string | null;
    lastStatus: string;
    lastError: string | null;
    lastPolledAt: Date;
  },
) {
  const now = new Date();
  await tx
    .insert(discoveryCursors)
    .values({
      agentId,
      provider: X_PROVIDER,
      sinceId: values.sinceId,
      lastStatus: values.lastStatus,
      lastError: values.lastError,
      lastPolledAt: values.lastPolledAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [discoveryCursors.agentId, discoveryCursors.provider],
      set: {
        sinceId: values.sinceId,
        lastStatus: values.lastStatus,
        lastError: values.lastError,
        lastPolledAt: values.lastPolledAt,
        updatedAt: now,
      },
    });
}

async function persistPosts(
  tx: Tx,
  agentId: string,
  posts: XSearchPost[],
): Promise<(typeof sourceEvents.$inferSelect)[]> {
  if (!posts.length) return [];
  const rows = await Promise.all(
    posts.map((post) =>
      tx
        .insert(sourceEvents)
        .values({
          agentId,
          provider: X_PROVIDER,
          providerEventId: post.id,
          payload: post.raw,
          text: post.text,
          authorId: post.authorId ?? null,
          authorUsername: post.authorUsername ?? null,
          providerCreatedAt: post.createdAt ? new Date(post.createdAt) : null,
        })
        .onConflictDoNothing()
        .returning(),
    ),
  );
  return rows.flatMap((row) => row.at(0) ?? []);
}

/**
 * Poll one agent's configured X search query in shadow mode.
 * Persists and deduplicates source events before any evaluation.
 */
export async function processDiscoveryPoll(
  job: Pick<JobRecord, 'payload'>,
  signal?: AbortSignal,
  options: DiscoveryPollOptions = {},
): Promise<DiscoveryPollResult> {
  const agentId = typeof job.payload.agentId === 'string' ? job.payload.agentId : null;
  if (!agentId) throw new Error('x.discovery.poll payload missing agentId');

  const adapter = options.adapter ?? createXSearchAdapter();
  const pollIntervalMs = options.pollIntervalMs ?? X_DISCOVERY_POLL_INTERVAL_MS;
  const evaluate = options.evaluate !== false;
  const now = options.now ?? new Date();
  const nextPoll = new Date(now.getTime() + pollIntervalMs);

  const prep = await db().transaction(async (tx) => {
    const agent = (await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')).at(
      0,
    );
    if (!agent) {
      return { kind: 'done' as const, result: emptyResult('agent_missing') };
    }

    const lifecycle = agent.lifecycle;
    if (!canAcceptBackgroundWork(lifecycle)) {
      const cursor = await readCursor(tx, agentId);
      await upsertCursor(tx, agentId, {
        sinceId: cursor?.sinceId ?? null,
        lastStatus: `skipped_${lifecycle}`,
        lastError: null,
        lastPolledAt: now,
      });
      return {
        kind: 'done' as const,
        result: emptyResult(`skipped_${lifecycle}`, cursor?.sinceId),
      };
    }

    const version = (
      await tx
        .select()
        .from(configurations)
        .where(eq(configurations.agentId, agentId))
        .orderBy(desc(configurations.version))
        .limit(1)
    ).at(0);
    if (!version) {
      await upsertCursor(tx, agentId, {
        sinceId: null,
        lastStatus: 'missing_config',
        lastError: 'No configuration version found.',
        lastPolledAt: now,
      });
      return { kind: 'done' as const, result: emptyResult('missing_config') };
    }

    const config = readConfig(version.config);
    const query = config.xSearchQuery.trim();
    if (!query) {
      const cursor = await readCursor(tx, agentId);
      await upsertCursor(tx, agentId, {
        sinceId: cursor?.sinceId ?? null,
        lastStatus: 'no_query',
        lastError: null,
        lastPolledAt: now,
      });
      return { kind: 'done' as const, result: emptyResult('no_query', cursor?.sinceId) };
    }

    const availability = adapter.availability();
    if (!availability.available) {
      const cursor = await readCursor(tx, agentId);
      await upsertCursor(tx, agentId, {
        sinceId: cursor?.sinceId ?? null,
        lastStatus: 'unavailable',
        lastError: availability.reason,
        lastPolledAt: now,
      });
      return {
        kind: 'done' as const,
        result: {
          ...emptyResult('unavailable', cursor?.sinceId),
          deferUntil: nextPoll,
          error: availability.reason,
        },
      };
    }

    const cursor = await readCursor(tx, agentId);
    return {
      kind: 'search' as const,
      agent,
      version,
      query,
      sinceId: cursor?.sinceId ?? null,
    };
  });

  if (prep.kind === 'done') return prep.result;

  let search;
  try {
    search = await adapter.searchRecent({
      query: prep.query,
      sinceId: prep.sinceId,
      signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'X search failed.';
    await db().transaction(async (tx) => {
      await upsertCursor(tx, agentId, {
        sinceId: prep.sinceId,
        lastStatus: 'error',
        lastError: message.slice(0, 2000),
        lastPolledAt: now,
      });
    });
    return {
      ...emptyResult('error', prep.sinceId),
      deferUntil: nextPoll,
      error: message,
    };
  }

  return await db().transaction(async (tx) => {
    // Re-lock agent so pause/stop between prep and persist still stops evaluation.
    const agent = (await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')).at(
      0,
    );
    if (!agent || !canAcceptBackgroundWork(agent.lifecycle)) {
      const status = !agent ? 'agent_missing' : `skipped_${agent.lifecycle}`;
      await upsertCursor(tx, agentId, {
        sinceId: prep.sinceId,
        lastStatus: status,
        lastError: null,
        lastPolledAt: now,
      });
      return emptyResult(status, prep.sinceId);
    }

    const inserted = await persistPosts(tx, agentId, search.posts);

    let sinceId = prep.sinceId;
    if (search.newestId) {
      if (!sinceId || compareSnowflake(search.newestId, sinceId) > 0) {
        sinceId = search.newestId;
      }
    }

    await upsertCursor(tx, agentId, {
      sinceId,
      lastStatus: 'ok',
      lastError: null,
      lastPolledAt: now,
    });

    const evaluated =
      evaluate && inserted.length
        ? await admitDiscoveryEvents(tx, agent, prep.version.id, inserted)
        : 0;

    return {
      status: 'ok',
      inserted: inserted.length,
      evaluated,
      sinceId,
      deferUntil: nextPoll,
    };
  });
}

/** Admit shadow evaluation runs one at a time (shared agent lock / budget counters). */
async function admitDiscoveryEvents(
  tx: Tx,
  agent: typeof agents.$inferSelect,
  configurationId: string,
  events: (typeof sourceEvents.$inferSelect)[],
  index = 0,
  evaluated = 0,
): Promise<number> {
  if (index >= events.length) return evaluated;
  const event = events[index];
  const post: XSearchPost = {
    id: event.providerEventId,
    text: event.text,
    authorId: event.authorId ?? undefined,
    authorUsername: event.authorUsername ?? undefined,
    createdAt: event.providerCreatedAt?.toISOString(),
    raw: event.payload,
  };
  const admitted = await admitRun(tx, agent, {
    actor: X_DISCOVERY_ACTOR,
    configurationId,
    input: formatDiscoveryInput(post),
    origin: 'discovery',
  });
  let nextCount = evaluated;
  if ('runId' in admitted && admitted.runId) {
    await tx
      .update(sourceEvents)
      .set({ runId: admitted.runId })
      .where(eq(sourceEvents.id, event.id));
    nextCount += 1;
  }
  return admitDiscoveryEvents(tx, agent, configurationId, events, index + 1, nextCount);
}

async function readCursor(tx: Tx, agentId: string) {
  return (
    await tx
      .select()
      .from(discoveryCursors)
      .where(and(eq(discoveryCursors.agentId, agentId), eq(discoveryCursors.provider, X_PROVIDER)))
  ).at(0);
}

function emptyResult(status: string, sinceId: string | null = null): DiscoveryPollResult {
  return { status, inserted: 0, evaluated: 0, sinceId };
}
