import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import postgres from 'postgres';

import { budgetDefaults } from '@/lib/budgets';
import { createFixtureXSearchAdapter, FIXTURE_X_POSTS } from '@/lib/runtime/x/fixture';
import { ensureDiscoveryPollJob, processDiscoveryPoll } from '@/lib/runtime/x/poll';
import { X_DISCOVERY_POLL_JOB, X_PROVIDER } from '@/lib/runtime/x/types';
import { persistLifecycle } from '@/lib/server/lifecycle-mutations';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://orbit:orbit_dev@localhost:5432/orbit_test';
const sql = postgres(databaseUrl);
const ids: string[] = [];
const admin = 'admin@example.test';
const signal = new AbortController().signal;

afterAll(async () => {
  try {
    for (const id of ids) {
      await sql`DELETE FROM source_events WHERE agent_id=${id}`;
      await sql`DELETE FROM discovery_cursors WHERE agent_id=${id}`;
      await sql`DELETE FROM policy_decisions WHERE agent_id=${id}`;
      await sql`DELETE FROM action_intents WHERE agent_id=${id}`;
      await sql`DELETE FROM usage_counters WHERE agent_id=${id}`;
      await sql`DELETE FROM simulation_runs WHERE agent_id=${id}`;
      await sql`DELETE FROM jobs WHERE payload->>'agentId'=${id}`;
      await sql`DELETE FROM agent_configurations WHERE agent_id=${id}`;
      await sql`DELETE FROM agents WHERE id=${id}`;
    }
  } finally {
    await sql.end();
  }
});

async function createAgent(name: string, query: string, lifecycle = 'shadow') {
  const id = randomUUID();
  ids.push(id);
  const [template] = await sql`SELECT config FROM templates WHERE id='sales'`;
  const config = {
    ...template!.config,
    name,
    xSearchQuery: query,
  };
  await sql`INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES(${id},${name},${config.mission},${lifecycle},${sql.json(budgetDefaults)},${sql.json([])})`;
  await sql`INSERT INTO agent_configurations(agent_id,version,config,actor)
    VALUES(${id},1,${sql.json(config)},${admin})`;
  return id;
}

test('repeated polls dedupe source events and advance since_id', async () => {
  const agentId = await createAgent('Discovery John', 'work-history');
  const adapter = createFixtureXSearchAdapter();

  const first = await processDiscoveryPoll({ payload: { agentId } }, signal, {
    adapter,
    evaluate: false,
    pollIntervalMs: 60_000,
  });
  expect(first.status).toBe('ok');
  expect(first.inserted).toBe(1);
  expect(first.sinceId).toBe('1001');

  const second = await processDiscoveryPoll({ payload: { agentId } }, signal, {
    adapter,
    evaluate: false,
    pollIntervalMs: 60_000,
  });
  expect(second.status).toBe('ok');
  expect(second.inserted).toBe(0);
  expect(second.sinceId).toBe('1001');

  const events =
    await sql`SELECT provider_event_id FROM source_events WHERE agent_id=${agentId} ORDER BY provider_event_id`;
  expect(events.map((row) => row.provider_event_id)).toEqual(['1001']);

  const [cursor] =
    await sql`SELECT since_id, last_status FROM discovery_cursors WHERE agent_id=${agentId} AND provider=${X_PROVIDER}`;
  expect(cursor?.since_id).toBe('1001');
  expect(cursor?.last_status).toBe('ok');
});

test('restart resumes from the saved cursor', async () => {
  const agentId = await createAgent('Discovery Resume', '*');
  const adapter = createFixtureXSearchAdapter(FIXTURE_X_POSTS);

  const first = await processDiscoveryPoll({ payload: { agentId } }, signal, {
    adapter,
    evaluate: false,
  });
  expect(first.inserted).toBe(3);
  expect(first.sinceId).toBe('1003');

  // Simulate process restart: only the persisted cursor remains.
  const [cursor] =
    await sql`SELECT since_id FROM discovery_cursors WHERE agent_id=${agentId} AND provider=${X_PROVIDER}`;
  expect(cursor?.since_id).toBe('1003');

  const restarted = await processDiscoveryPoll({ payload: { agentId } }, signal, {
    adapter,
    evaluate: false,
  });
  expect(restarted.inserted).toBe(0);
  expect(restarted.sinceId).toBe('1003');
});

test('paused and stopped agents stop polling', async () => {
  const pausedId = await createAgent('Paused Scout', 'work-history', 'paused');
  const stoppedId = await createAgent('Stopped Scout', 'work-history', 'stopped');
  const adapter = createFixtureXSearchAdapter();

  const paused = await processDiscoveryPoll({ payload: { agentId: pausedId } }, signal, {
    adapter,
    evaluate: false,
  });
  expect(paused.status).toBe('skipped_paused');
  expect(paused.inserted).toBe(0);
  expect(paused.deferUntil).toBeUndefined();

  const stopped = await processDiscoveryPoll({ payload: { agentId: stoppedId } }, signal, {
    adapter,
    evaluate: false,
  });
  expect(stopped.status).toBe('skipped_stopped');
  expect(stopped.deferUntil).toBeUndefined();

  const events =
    await sql`SELECT count(*)::int AS count FROM source_events WHERE agent_id IN (${pausedId}, ${stoppedId})`;
  expect(events[0]?.count).toBe(0);
});

test('two agents with independent queries stay independent', async () => {
  const johnId = await createAgent('Independent John', 'work-history');
  const noiseId = await createAgent('Independent Noise', 'lunch');
  const adapter = createFixtureXSearchAdapter();

  const john = await processDiscoveryPoll({ payload: { agentId: johnId } }, signal, {
    adapter,
    evaluate: false,
  });
  const noise = await processDiscoveryPoll({ payload: { agentId: noiseId } }, signal, {
    adapter,
    evaluate: false,
  });

  expect(john.inserted).toBe(1);
  expect(noise.inserted).toBe(1);

  const johnEvents =
    await sql`SELECT provider_event_id FROM source_events WHERE agent_id=${johnId}`;
  const noiseEvents =
    await sql`SELECT provider_event_id FROM source_events WHERE agent_id=${noiseId}`;
  expect(johnEvents.map((row) => row.provider_event_id)).toEqual(['1001']);
  expect(noiseEvents.map((row) => row.provider_event_id)).toEqual(['1003']);
});

test('unavailable adapter records status without crashing', async () => {
  const agentId = await createAgent('No Token', 'work-history');
  const adapter = {
    name: 'x-api' as const,
    availability: () =>
      ({
        available: false as const,
        reason: 'X_BEARER_TOKEN is not set. X discovery polling is unavailable.',
      }) as const,
    searchRecent: async () => {
      throw new Error('should not be called');
    },
  };

  const result = await processDiscoveryPoll({ payload: { agentId } }, signal, {
    adapter,
    evaluate: false,
    pollIntervalMs: 1_000,
  });
  expect(result.status).toBe('unavailable');
  expect(result.deferUntil).toBeInstanceOf(Date);
  const [cursor] =
    await sql`SELECT last_status, last_error FROM discovery_cursors WHERE agent_id=${agentId}`;
  expect(cursor?.last_status).toBe('unavailable');
  expect(cursor?.last_error).toContain('X_BEARER_TOKEN');
});

test('new events enqueue shadow discovery evaluation runs', async () => {
  const agentId = await createAgent('Eval John', 'work-history');
  const adapter = createFixtureXSearchAdapter();
  const result = await processDiscoveryPoll({ payload: { agentId } }, signal, {
    adapter,
    evaluate: true,
    pollIntervalMs: 60_000,
  });
  expect(result.inserted).toBe(1);
  expect(result.evaluated).toBe(1);
  const runs =
    await sql`SELECT origin, status, input FROM simulation_runs WHERE agent_id=${agentId}`;
  expect(runs).toHaveLength(1);
  expect(runs[0]?.origin).toBe('discovery');
  expect(runs[0]?.status).toBe('queued');
  expect(runs[0]?.input).toContain('1001');
  const events = await sql`SELECT run_id FROM source_events WHERE agent_id=${agentId}`;
  expect(events[0]?.run_id).toBeTruthy();
});

test('ensureDiscoveryPollJob is idempotent while pending and recreates after cancel', async () => {
  const agentId = await createAgent('Poll Job', 'work-history');
  const first = await ensureDiscoveryPollJob(agentId);
  const second = await ensureDiscoveryPollJob(agentId);
  expect(first.id).toBe(second.id);
  expect(first.type).toBe(X_DISCOVERY_POLL_JOB);

  await persistLifecycle(admin, agentId, 'paused');
  const [cancelled] = await sql`SELECT status FROM jobs WHERE id=${first.id}`;
  expect(cancelled?.status).toBe('cancelled');

  await persistLifecycle(admin, agentId, 'shadow');
  const [active] =
    await sql`SELECT id, status FROM jobs WHERE payload->>'agentId'=${agentId} AND type=${X_DISCOVERY_POLL_JOB} AND status='pending'`;
  expect(active?.id).toBeTruthy();
  expect(active?.id).not.toBe(first.id);
});
