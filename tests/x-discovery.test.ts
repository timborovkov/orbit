import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import postgres from 'postgres';

import { budgetDefaults } from '@/lib/budgets';
import { processSimulationJob } from '@/lib/runtime/execute';
import type { ModelCall } from '@/lib/runtime/simulation';
import { createFixtureXSearchAdapter, FIXTURE_X_POSTS } from '@/lib/runtime/x/fixture';
import { ensureDiscoveryPollJob, processDiscoveryPoll } from '@/lib/runtime/x/poll';
import { X_DISCOVERY_POLL_JOB, X_PROVIDER } from '@/lib/runtime/x/types';
import { createAgentFromTemplate } from '@/lib/server/agents-mutations';
import { persistLifecycle } from '@/lib/server/lifecycle-mutations';
import { selectAgentMemoryEvidence } from '@/lib/server/memory-queries';

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

test('multi-post poll keeps unevaluated events when concurrency is full and retries later', async () => {
  const agentId = await createAgent('Capacity Batch', '*');
  const adapter = createFixtureXSearchAdapter();

  const first = await processDiscoveryPoll({ payload: { agentId } }, signal, {
    adapter,
    evaluate: true,
    pollIntervalMs: 60_000,
  });
  expect(first.status).toBe('waiting_capacity');
  expect(first.inserted).toBe(3);
  expect(first.evaluated).toBe(1);
  expect(first.pending).toBe(2);
  expect(first.sinceId).toBe('1003');
  expect(first.deferUntil).toBeInstanceOf(Date);

  const events =
    await sql`SELECT provider_event_id, run_id FROM source_events WHERE agent_id=${agentId} ORDER BY provider_event_id`;
  expect(events).toHaveLength(3);
  expect(events.filter((row) => row.run_id).map((row) => row.provider_event_id)).toEqual(['1001']);
  expect(events.filter((row) => !row.run_id).map((row) => row.provider_event_id)).toEqual([
    '1002',
    '1003',
  ]);

  await sql`UPDATE simulation_runs SET status='completed', finished_at=now() WHERE agent_id=${agentId}`;

  const second = await processDiscoveryPoll({ payload: { agentId } }, signal, {
    adapter,
    evaluate: true,
    pollIntervalMs: 60_000,
  });
  expect(second.status).toBe('waiting_capacity');
  expect(second.inserted).toBe(0);
  expect(second.evaluated).toBe(1);
  expect(second.pending).toBe(1);
  expect(second.sinceId).toBe('1003');

  await sql`UPDATE simulation_runs SET status='completed', finished_at=now() WHERE agent_id=${agentId} AND status='queued'`;

  const third = await processDiscoveryPoll({ payload: { agentId } }, signal, {
    adapter,
    evaluate: true,
    pollIntervalMs: 60_000,
  });
  expect(third.status).toBe('ok');
  expect(third.evaluated).toBe(1);
  expect(third.pending).toBe(0);
  expect(third.sinceId).toBe('1003');

  const remaining =
    await sql`SELECT count(*)::int AS count FROM source_events WHERE agent_id=${agentId} AND run_id IS NULL`;
  expect(remaining[0]?.count).toBe(0);
});

test('poll during an active run advances since_id without dropping unevaluated events', async () => {
  const agentId = await createAgent('Active Run Scout', 'work-history');
  const [version] =
    await sql`SELECT id FROM agent_configurations WHERE agent_id=${agentId} AND version=1`;
  await sql`INSERT INTO simulation_runs(agent_id,configuration_id,origin,status,input,result,actor,expires_at)
    VALUES(${agentId},${version!.id},'playground','running','busy',${sql.json({ steps: [], actions: [], error: null })},${admin},now() + interval '10 minutes')`;

  const adapter = createFixtureXSearchAdapter();
  const result = await processDiscoveryPoll({ payload: { agentId } }, signal, {
    adapter,
    evaluate: true,
    pollIntervalMs: 60_000,
  });
  expect(result.status).toBe('waiting_capacity');
  expect(result.inserted).toBe(1);
  expect(result.evaluated).toBe(0);
  expect(result.pending).toBe(1);
  expect(result.sinceId).toBe('1001');

  const events =
    await sql`SELECT provider_event_id, run_id FROM source_events WHERE agent_id=${agentId}`;
  expect(events).toHaveLength(1);
  expect(events[0]?.run_id).toBeNull();

  await sql`UPDATE simulation_runs SET status='completed', finished_at=now() WHERE agent_id=${agentId}`;

  const retry = await processDiscoveryPoll({ payload: { agentId } }, signal, {
    adapter,
    evaluate: true,
    pollIntervalMs: 60_000,
  });
  expect(retry.status).toBe('ok');
  expect(retry.evaluated).toBe(1);
  expect(retry.pending).toBe(0);
  expect(retry.sinceId).toBe('1001');
});

test('pause while poll is claimed then resume keeps a discovery poller', async () => {
  const agentId = await createAgent('Claim Race Scout', 'work-history');
  const claimed = await ensureDiscoveryPollJob(agentId);
  await sql`
    UPDATE jobs
    SET status='claimed',
        claimed_by='test-worker',
        claimed_at=now(),
        claim_expires_at=now() + interval '5 minutes',
        updated_at=now()
    WHERE id=${claimed.id}
  `;

  await persistLifecycle(admin, agentId, 'paused');
  const [stillClaimed] = await sql`SELECT status, idempotency_key FROM jobs WHERE id=${claimed.id}`;
  expect(stillClaimed?.status).toBe('claimed');
  expect(stillClaimed?.idempotency_key).toBe(`x.discovery.poll:${agentId}`);

  await persistLifecycle(admin, agentId, 'shadow');
  const replacements =
    await sql`SELECT id, status, idempotency_key FROM jobs WHERE payload->>'agentId'=${agentId} AND type=${X_DISCOVERY_POLL_JOB} AND status='pending'`;
  expect(replacements).toHaveLength(1);
  expect(replacements[0]?.idempotency_key).toBe(`x.discovery.poll:${agentId}`);
  expect(replacements[0]?.id).not.toBe(claimed.id);

  const [detached] = await sql`SELECT status, idempotency_key FROM jobs WHERE id=${claimed.id}`;
  expect(detached?.status).toBe('claimed');
  expect(detached?.idempotency_key).toBeNull();

  const adapter = createFixtureXSearchAdapter();
  const finished = await processDiscoveryPoll({ payload: { agentId }, id: claimed.id }, signal, {
    adapter,
    evaluate: false,
    jobId: claimed.id,
    pollIntervalMs: 60_000,
  });
  // Lost the idempotency key to the resume replacement — complete instead of defer.
  expect(finished.deferUntil).toBeUndefined();

  const [replacement] = await sql`SELECT status FROM jobs WHERE id=${replacements[0]!.id}`;
  expect(replacement?.status).toBe('pending');
});

test('createAgentFromTemplate enqueues discovery poll when template has xSearchQuery', async () => {
  const [template] = await sql`SELECT config FROM templates WHERE id='sales'`;
  const previous = template!.config;
  const patched = { ...previous, xSearchQuery: 'work-history' };
  await sql`UPDATE templates SET config=${sql.json(patched)} WHERE id='sales'`;

  const name = `Template Discovery ${randomUUID().slice(0, 8)}`;
  try {
    const created = await createAgentFromTemplate(admin, 'sales', {
      name,
      mission: 'Find discovery leads',
    });
    expect(created.ok).toBe(true);

    const [agent] = await sql`SELECT id FROM agents WHERE name=${name}`;
    expect(agent?.id).toBeTruthy();
    ids.push(agent!.id);

    const [config] =
      await sql`SELECT config->>'xSearchQuery' AS query FROM agent_configurations WHERE agent_id=${agent!.id} AND version=1`;
    expect(config?.query).toBe('work-history');

    const pollJobs =
      await sql`SELECT type, status FROM jobs WHERE payload->>'agentId'=${agent!.id} AND type=${X_DISCOVERY_POLL_JOB}`;
    expect(pollJobs).toHaveLength(1);
    expect(pollJobs[0]?.status).toBe('pending');
  } finally {
    await sql`UPDATE templates SET config=${sql.json(previous)} WHERE id='sales'`;
  }
});

test('a discovery run can remember a project detail with evidence from its event', async () => {
  const agentId = await createAgent('Discovery memory', '*');
  const quote = 'Project Juniper moves to pilot in December.';
  const adapter = createFixtureXSearchAdapter([{ id: '2001', text: quote, raw: {} }]);
  expect(
    await processDiscoveryPoll({ payload: { agentId } }, signal, {
      adapter,
      evaluate: true,
    }),
  ).toMatchObject({ evaluated: 1 });
  const [event] = await sql`SELECT id,run_id FROM source_events WHERE agent_id=${agentId}`;
  const inference: ModelCall = async (request) => {
    expect(request.stage).toBe('evaluator');
    expect(request.captureMemory).toBe(true);
    expect(JSON.parse(request.input).untrustedMemorySource).toEqual([quote]);
    return {
      inputTokens: 5,
      outputTokens: 1,
      decision: { relevant: false, priority: 0, reason: 'Informational', actions: [] },
      memoryCandidates: [
        {
          subjectKind: 'project',
          subject: 'Juniper',
          topic: 'Pilot timing',
          fact: quote,
          quote,
        },
      ],
    };
  };
  inference.quote = async () => ({
    upperBoundMicros: 100,
    endpoint: 'Fixture',
    maxPrice: { prompt: 1, completion: 1, request: 0 },
  });
  const priorKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'fixture';
  try {
    await processSimulationJob({ runId: event!.run_id }, () => inference);
  } finally {
    if (priorKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorKey;
  }
  const [memory] =
    await sql`SELECT id,revision,source_kind,source_id,subject_kind FROM agent_memories WHERE agent_id=${agentId}`;
  expect(memory).toMatchObject({
    source_kind: 'event',
    source_id: event!.id,
    subject_kind: 'project',
  });
  expect(await selectAgentMemoryEvidence(agentId, memory!.id, memory!.revision)).toMatchObject({
    source: { id: event!.id, body: quote },
    quote,
  });
  await sql`DELETE FROM source_events WHERE id=${event!.id}`;
  expect(await sql`SELECT id FROM agent_memories WHERE id=${memory!.id}`).toHaveLength(0);
  expect(await selectAgentMemoryEvidence(agentId, memory!.id, memory!.revision)).toBeNull();
});
