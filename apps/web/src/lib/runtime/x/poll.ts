import { and, asc, desc, eq, isNull } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import { canAcceptBackgroundWork } from '@/lib/lifecycle';
import { enqueueJob } from '@/lib/queue/jobs';
import type { JobRecord } from '@/lib/queue/types';
import { admitChannelEvent, persistChannelEvent } from '@/lib/runtime/channels/ingest';
import { type AgentConfig, configSchema, discoveryQueries } from '@/lib/runtime/config';
import {
  lockPeople,
  observedClaimedHandle,
  reconcilePeople,
  xEmailClaim,
} from '@/lib/runtime/people/identity';
import { createXSearchAdapter } from '@/lib/runtime/x/adapter';
import { clampDiscoveryMaxPosts } from '@/lib/runtime/x/discovery-cost';
import { compareSnowflake } from '@/lib/runtime/x/fixture';
import { capDiscoveryPosts, prefilterDiscoveryPosts } from '@/lib/runtime/x/relevance-prefilter';
import { xPostId } from '@/lib/runtime/x/reply-input';
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
  /** Claimed job id — used so resume races can coordinate with this claim. */
  jobId?: string;
}

export interface DiscoveryPollResult {
  status: string;
  inserted: number;
  evaluated: number;
  /** Unevaluated source events still waiting for capacity. */
  pending: number;
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
 *
 * Pending jobs are reused. The in-flight claim is reused only when `claimJobId`
 * matches — a concurrent resume detaches the key from that claim and enqueues a
 * replacement so the resumed agent is never left without a poller.
 */
export async function ensureDiscoveryPollJob(
  agentId: string,
  store: Tx | ReturnType<typeof db> = db(),
  availableAt = new Date(),
  claimJobId?: string,
): Promise<JobRecord> {
  const key = discoveryPollIdempotencyKey(agentId);
  const existing = (
    await store.select().from(jobs).where(eq(jobs.idempotencyKey, key)).limit(1)
  ).at(0);
  if (existing?.status === 'pending') return mapJob(existing);
  if (existing?.status === 'claimed' && claimJobId && existing.id === claimJobId) {
    return mapJob(existing);
  }
  if (existing) {
    // Terminal rows, or a foreign/in-flight claim during resume: free the key.
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
      persistChannelEvent(tx, {
        agentId,
        provider: X_PROVIDER,
        providerEventId: post.id,
        threadId: post.conversationId,
        payload: post.raw,
        text: post.text,
        authorId: post.authorId ?? null,
        authorUsername: post.authorUsername ?? null,
        authorName: post.authorName ?? null,
        personClaim: post.authorId && post.authorUsername ? xEmailClaim(post.text) : null,
        providerCreatedAt: post.createdAt ? new Date(post.createdAt) : null,
      }),
    ),
  );
  const inserted = rows.flatMap((row) => row ?? []);
  const handles = [
    ...new Set(
      inserted.flatMap(({ authorUsername, personIdentityId }) =>
        authorUsername && personIdentityId ? [authorUsername.toLowerCase()] : [],
      ),
    ),
  ];
  if (handles.length) await lockPeople(tx);
  if (
    inserted.some(({ personIdentityId, personClaim }) => personIdentityId && personClaim) ||
    (await observedClaimedHandle(tx, handles))
  ) {
    await reconcilePeople(tx);
  }
  return inserted;
}

async function listUnevaluatedEvents(tx: Tx, agentId: string) {
  return tx
    .select()
    .from(sourceEvents)
    .where(
      and(
        eq(sourceEvents.agentId, agentId),
        eq(sourceEvents.provider, X_PROVIDER),
        isNull(sourceEvents.runId),
      ),
    )
    .orderBy(asc(sourceEvents.ingestedAt), asc(sourceEvents.providerEventId));
}

/**
 * Under the agent row lock: if the agent can still run discovery, keep polling
 * via deferUntil — covering pause→resume while this claim was in flight.
 * When resume already replaced our idempotency key, complete this claim and let
 * the replacement pending job own the loop.
 */
async function resolvePollContinuation(
  tx: Tx,
  agentId: string,
  result: DiscoveryPollResult,
  nextPoll: Date,
  jobId?: string,
): Promise<DiscoveryPollResult> {
  const agent = (await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')).at(0);
  if (!agent || !canAcceptBackgroundWork(agent.lifecycle)) {
    return { ...result, deferUntil: undefined };
  }
  const version = (
    await tx
      .select()
      .from(configurations)
      .where(eq(configurations.agentId, agentId))
      .orderBy(desc(configurations.version))
      .limit(1)
  ).at(0);
  const config = version ? readConfig(version.config) : null;
  if (!config || config.xDiscoveryPaused || !discoveryQueries(config).length) {
    return { ...result, deferUntil: undefined };
  }

  const key = discoveryPollIdempotencyKey(agentId);
  await ensureDiscoveryPollJob(agentId, tx, nextPoll, jobId);
  if (jobId) {
    const claim = (await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1)).at(0);
    // Resume detached our key onto a fresh pending job — finish this claim.
    if (claim?.idempotencyKey !== key) {
      return { ...result, deferUntil: undefined };
    }
  }
  return { ...result, deferUntil: result.deferUntil ?? nextPoll };
}

/**
 * Poll one agent's configured X search query in shadow mode.
 * Persists and deduplicates source events before any evaluation.
 * Unevaluated events (`run_id IS NULL`) are retried on later polls when capacity opens.
 */
export async function processDiscoveryPoll(
  job: Pick<JobRecord, 'payload'> & { id?: string },
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
  const capacityRetry = new Date(now.getTime() + Math.min(pollIntervalMs, 5_000));
  const jobId = options.jobId ?? job.id;

  const prep = await db().transaction(async (tx) => {
    const agent = (await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')).at(
      0,
    );
    if (!agent) {
      return {
        kind: 'done' as const,
        result: await resolvePollContinuation(
          tx,
          agentId,
          emptyResult('agent_missing'),
          nextPoll,
          jobId,
        ),
      };
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
        result: await resolvePollContinuation(
          tx,
          agentId,
          emptyResult(`skipped_${lifecycle}`, cursor?.sinceId),
          nextPoll,
          jobId,
        ),
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
      return {
        kind: 'done' as const,
        result: await resolvePollContinuation(
          tx,
          agentId,
          emptyResult('missing_config'),
          nextPoll,
          jobId,
        ),
      };
    }

    const config = readConfig(version.config);
    const queries = discoveryQueries(config);
    if (!queries.length) {
      const cursor = await readCursor(tx, agentId);
      await upsertCursor(tx, agentId, {
        sinceId: cursor?.sinceId ?? null,
        lastStatus: 'no_query',
        lastError: null,
        lastPolledAt: now,
      });
      return {
        kind: 'done' as const,
        result: await resolvePollContinuation(
          tx,
          agentId,
          emptyResult('no_query', cursor?.sinceId),
          nextPoll,
          jobId,
        ),
      };
    }

    if (config.xDiscoveryPaused) {
      const cursor = await readCursor(tx, agentId);
      await upsertCursor(tx, agentId, {
        sinceId: cursor?.sinceId ?? null,
        lastStatus: 'paused',
        lastError: null,
        lastPolledAt: now,
      });
      return {
        kind: 'done' as const,
        result: await resolvePollContinuation(
          tx,
          agentId,
          emptyResult('paused', cursor?.sinceId),
          nextPoll,
          jobId,
        ),
      };
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
        result: await resolvePollContinuation(
          tx,
          agentId,
          {
            ...emptyResult('unavailable', cursor?.sinceId),
            deferUntil: nextPoll,
            error: availability.reason,
          },
          nextPoll,
          jobId,
        ),
      };
    }

    const cursor = await readCursor(tx, agentId);
    return {
      kind: 'search' as const,
      agent,
      version,
      config,
      queries,
      sinceId: cursor?.sinceId ?? null,
    };
  });

  if (prep.kind === 'done') return prep.result;

  const maxPosts = clampDiscoveryMaxPosts(prep.config.xDiscoveryMaxPostsPerPoll);
  const merged = new Map<string, XSearchPost>();
  let newestId = prep.sinceId;
  try {
    // Queries are independent; search in parallel then merge/cap.
    const searches = await Promise.all(
      prep.queries.map((query) =>
        adapter.searchRecent({
          query,
          sinceId: prep.sinceId,
          maxResults: Math.min(Math.max(maxPosts, 10), 100),
          signal,
        }),
      ),
    );
    for (const search of searches) {
      for (const post of search.posts) merged.set(post.id, post);
      if (search.newestId && (!newestId || compareSnowflake(search.newestId, newestId) > 0)) {
        newestId = search.newestId;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'X search failed.';
    return await db().transaction(async (tx) => {
      await upsertCursor(tx, agentId, {
        sinceId: prep.sinceId,
        lastStatus: 'error',
        lastError: message.slice(0, 2000),
        lastPolledAt: now,
      });
      return resolvePollContinuation(
        tx,
        agentId,
        {
          ...emptyResult('error', prep.sinceId),
          deferUntil: nextPoll,
          error: message,
        },
        nextPoll,
        jobId,
      );
    });
  }

  const ordered = [...merged.values()].sort((a, b) => compareSnowflake(a.id, b.id));
  const { kept } = prefilterDiscoveryPosts(ordered, {
    mission: prep.config.mission,
    engagementCriteria: prep.config.engagementCriteria,
    hints: prep.queries,
  });
  const posts = capDiscoveryPosts(kept, maxPosts);

  return await db().transaction(async (tx) => {
    // Re-lock agent so pause/stop between prep and persist still stops evaluation.
    const agent = (await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')).at(
      0,
    );
    if (!agent || !canAcceptBackgroundWork(agent.lifecycle)) {
      const status = !agent ? 'agent_missing' : `skipped_${agent.lifecycle}`;
      // Persist fetched posts even when lifecycle flipped — they stay unevaluated
      // until a later poll admits them; advance since_id so we do not re-fetch.
      const inserted = await persistPosts(tx, agentId, posts);
      let sinceId = prep.sinceId;
      if (newestId && (!sinceId || compareSnowflake(newestId, sinceId) > 0)) {
        sinceId = newestId;
      }
      await upsertCursor(tx, agentId, {
        sinceId,
        lastStatus: status,
        lastError: null,
        lastPolledAt: now,
      });
      const pending = (await listUnevaluatedEvents(tx, agentId)).length;
      return resolvePollContinuation(
        tx,
        agentId,
        { status, inserted: inserted.length, evaluated: 0, pending, sinceId },
        nextPoll,
        jobId,
      );
    }

    const inserted = await persistPosts(tx, agentId, posts);

    let sinceId = prep.sinceId;
    if (newestId) {
      if (!sinceId || compareSnowflake(newestId, sinceId) > 0) {
        sinceId = newestId;
      }
    }

    await upsertCursor(tx, agentId, {
      sinceId,
      lastStatus: 'ok',
      lastError: null,
      lastPolledAt: now,
    });

    // Admit every unevaluated event (new + prior capacity rejects), not just this poll.
    const pendingEvents = evaluate ? await listUnevaluatedEvents(tx, agentId) : [];
    const admission = evaluate
      ? await admitDiscoveryEvents(tx, agent, prep.version.id, pendingEvents)
      : { evaluated: 0, waitingForCapacity: false, remaining: 0 };

    const result: DiscoveryPollResult = {
      status: admission.waitingForCapacity ? 'waiting_capacity' : 'ok',
      inserted: inserted.length,
      evaluated: admission.evaluated,
      pending: admission.remaining,
      sinceId,
      deferUntil: admission.waitingForCapacity ? capacityRetry : nextPoll,
    };
    return resolvePollContinuation(tx, agentId, result, nextPoll, jobId);
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
): Promise<{ evaluated: number; waitingForCapacity: boolean; remaining: number }> {
  if (index >= events.length) {
    return { evaluated, waitingForCapacity: false, remaining: 0 };
  }
  const event = events[index];
  const post: XSearchPost = {
    id: event.providerEventId,
    text: event.text,
    authorId: event.authorId ?? undefined,
    authorUsername: event.authorUsername ?? undefined,
    createdAt: event.providerCreatedAt?.toISOString(),
    raw: event.payload,
  };
  const admitted = await admitChannelEvent(tx, agent, event, {
    actor: X_DISCOVERY_ACTOR,
    configurationId,
    input: formatDiscoveryInput(post),
    recipients:
      event.authorId && xPostId.safeParse(event.authorId).success ? [`x:${event.authorId}`] : [],
  });
  if ('waitForCapacity' in admitted && admitted.waitForCapacity) {
    return {
      evaluated,
      waitingForCapacity: true,
      remaining: events.length - index,
    };
  }
  const nextCount = 'runId' in admitted && admitted.runId ? evaluated + 1 : evaluated;
  // Hard errors (missing config, budgets) still leave run_id null for retry.
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
  return { status, inserted: 0, evaluated: 0, pending: 0, sinceId };
}
