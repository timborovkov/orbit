import { afterAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import postgres from 'postgres';

import { budgetDefaults } from '@/lib/budgets';
import { claimJobs, completeJob, failJob } from '@/lib/queue/jobs';
import type { ChannelAction } from '@/lib/runtime/channels/types';
import { processSimulationJob, processSimulationRunForOrigin } from '@/lib/runtime/execute';
import { processOutboundJob } from '@/lib/runtime/outbound/process';
import { CHANNEL_OUTBOUND_JOB } from '@/lib/runtime/outbound/types';
import { encryptSecret } from '@/lib/runtime/secrets';
import type { ModelCall } from '@/lib/runtime/simulation';
import {
  createFixtureXSearchAdapter,
  FIXTURE_X_POSTS,
  FIXTURE_X_REPLY_POST,
} from '@/lib/runtime/x/fixture';
import { ensureDiscoveryPollJob, processDiscoveryPoll } from '@/lib/runtime/x/poll';
import { validateXReplyApproval, xReplySecretSubject } from '@/lib/runtime/x/reply';
import { X_REPLY_ACTION } from '@/lib/runtime/x/reply-input';
import { X_DISCOVERY_POLL_JOB, X_PROVIDER } from '@/lib/runtime/x/types';
import { createAgentFromTemplate } from '@/lib/server/agents-mutations';
import { persistGlobalPause } from '@/lib/server/controls-mutations';
import {
  persistApprovalTools,
  persistBudgets,
  persistLifecycle,
} from '@/lib/server/lifecycle-mutations';
import { selectAgentMemoryEvidence } from '@/lib/server/memory-queries';
import {
  persistChannelGrant,
  recordConsent,
  reviewProposedAction,
} from '@/lib/server/policy-mutations';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://orbit:orbit_dev@localhost:5432/orbit_test';
process.env.DATABASE_URL = databaseUrl;
const sql = postgres(databaseUrl);
const ids: string[] = [];
const admin = 'admin@example.test';
const signal = new AbortController().signal;
const workerId = 'x-reply-test';
const [initialControls] = await sql`SELECT paused FROM controls WHERE id=1`;
const originalKey = process.env.OPENROUTER_API_KEY;

afterAll(async () => {
  try {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await sql`UPDATE controls SET paused=${initialControls!.paused} WHERE id=1`;
    for (const id of ids) {
      await sql`DELETE FROM source_events WHERE agent_id=${id}`;
      await sql`DELETE FROM discovery_cursors WHERE agent_id=${id}`;
      await sql`DELETE FROM policy_decisions WHERE agent_id=${id}`;
      await sql`DELETE FROM outbound_actions WHERE agent_id=${id}`;
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

test('discovery admission binds the numeric author as the run recipient', async () => {
  const agentId = await createAgent('Author bind John', 'work-history');
  const adapter = createFixtureXSearchAdapter([FIXTURE_X_REPLY_POST]);
  expect(await processDiscoveryPoll({ payload: { agentId } }, signal, { adapter })).toMatchObject({
    inserted: 1,
    evaluated: 1,
  });
  const [run] =
    await sql`SELECT recipients FROM simulation_runs WHERE agent_id=${agentId} AND origin='discovery'`;
  expect(run?.recipients).toEqual(['x:12001']);
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
    expect(created.ok && created.agentId).toBeTruthy();

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

const replyInference: ModelCall = Object.assign<ModelCall, Pick<ModelCall, 'quote'>>(
  async ({ stage }) => ({
    decision: {
      relevant: true,
      priority: 1,
      reason: 'The fixture author asked John a question.',
      actions: [
        {
          type: X_REPLY_ACTION,
          reason: 'Answer the author’s question.',
          draft: stage === 'main' ? 'I can show you how The Timeline works.' : null,
        },
      ],
    },
    inputTokens: 1,
    outputTokens: 1,
    costMicros: 1,
  }),
  {
    quote: async () => ({
      upperBoundMicros: 1,
      endpoint: 'fixture',
      maxPrice: { prompt: 0, completion: 0, request: 0 },
    }),
  },
);

async function discoverReply(
  lifecycle: 'live' | 'shadow' = 'live',
  consent = true,
  connect?: (agentId: string) => Promise<void>,
) {
  process.env.OPENROUTER_API_KEY = 'x-fixture-inference';
  await persistGlobalPause(admin, false);
  const agentId = await createAgent('John reply fixture', 'work-history', lifecycle);
  await persistChannelGrant(admin, agentId, X_REPLY_ACTION, true);
  if (consent) await setXConsent(agentId, true);
  await connect?.(agentId);
  const adapter = createFixtureXSearchAdapter([FIXTURE_X_REPLY_POST]);
  const poll = () => processDiscoveryPoll({ payload: { agentId } }, signal, { adapter });
  expect(await poll()).toMatchObject({ inserted: 1, evaluated: 1 });
  const [run] =
    await sql`SELECT id, configuration_id, input FROM simulation_runs WHERE agent_id=${agentId}`;
  const work = () => processSimulationJob({ runId: run!.id }, () => replyInference, signal);
  await work();
  const rows = await sql`SELECT id, recipients, review_status, decision FROM action_intents
    WHERE agent_id=${agentId} AND action_type=${X_REPLY_ACTION}`;
  expect(rows).toHaveLength(1);
  return { agentId, run: run!, intent: rows[0]!, poll, work };
}

function setXConsent(agentId: string, granted: boolean) {
  return recordConsent({
    actor: admin,
    agentId,
    recipient: 'x:12001',
    scope: X_REPLY_ACTION,
    evidence: 'The fixture author asked for a reply on the source post.',
    granted,
  });
}

async function claimXReply(agentId: string) {
  const [job] = await claimJobs({ workerId, types: [CHANNEL_OUTBOUND_JOB], limit: 1 });
  expect(job?.payload.agentId).toBe(agentId);
  return job!;
}

type FixtureSend = Extract<
  Awaited<ReturnType<ChannelAction['prepareDelivery']>>,
  { send: unknown }
>['send'];

function fixtureXDelivery(outcomes: Awaited<ReturnType<FixtureSend>>[] = []) {
  const sent: string[] = [];
  const prepareDelivery: ChannelAction['prepareDelivery'] = async (tx, outbound, intent) => {
    const error = await validateXReplyApproval(tx, intent);
    if (error) return { error };
    return {
      recipients: intent.recipients,
      provider: 'x-fixture',
      send() {
        sent.push(outbound.body);
        return Promise.resolve(outcomes.shift() ?? { ok: true, id: '90001', raw: {} });
      },
    };
  };
  return { override: { actionType: X_REPLY_ACTION, prepareDelivery }, sent };
}

async function outboundFor(agentId: string) {
  const rows = await sql`SELECT status, reason, provider, provider_message_id FROM outbound_actions
    WHERE agent_id=${agentId}`;
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0];
}

test('John keeps one editable X reply in Shadow and an administrator can approve it in Live', async () => {
  const { agentId, intent, poll, work } = await discoverReply('shadow');
  expect(intent).toMatchObject({ review_status: 'pending', recipients: ['x:12001'] });
  expect(await poll()).toMatchObject({ inserted: 0, evaluated: 0 });
  expect(await reviewProposedAction(admin, agentId, intent.id, 'approved')).toHaveProperty('error');
  expect(await outboundFor(agentId)).toBeUndefined();
  await persistLifecycle(admin, agentId, 'live');
  await work();
  expect(await outboundFor(agentId)).toBeUndefined();
  const reviewed = await reviewProposedAction(admin, agentId, intent.id, 'approved', {
    editedPayload: { draft: 'Here is how work history is recorded.' },
  });
  expect(reviewed).toHaveProperty('message');
  const job = await claimXReply(agentId);
  const fixture = fixtureXDelivery();
  await processOutboundJob(job, signal, fixture.override);
  await processOutboundJob(job, signal, fixture.override);
  await completeJob(job.id, workerId);
  expect(fixture.sent).toEqual(['Here is how work history is recorded.']);
  expect(await outboundFor(agentId)).toMatchObject({
    status: 'sent',
    provider: 'x-fixture',
    provider_message_id: '90001',
  });
});

test('Live X grant queues the reply once and replay adds no write or approval', async () => {
  const { agentId, intent, run, poll, work } = await discoverReply();
  expect(intent).toMatchObject({ review_status: null, decision: 'allow' });
  expect(await poll()).toMatchObject({ inserted: 0, evaluated: 0 });
  await work();
  const [replay] =
    await sql`INSERT INTO simulation_runs(agent_id,configuration_id,origin,status,input,actor,expires_at,result)
    VALUES(${agentId},${run.configuration_id},'replay','queued',${run.input},${admin},now(),'{"steps":[],"actions":[],"error":null}') RETURNING id`;
  await processSimulationRunForOrigin(
    replay!.id,
    'replay',
    () => replyInference,
    signal,
    undefined,
    { channel: 'x', recallQuery: run.input },
  );
  const job = await claimXReply(agentId);
  const fixture = fixtureXDelivery();
  await processOutboundJob(job, signal, fixture.override);
  await completeJob(job.id, workerId);
  expect(fixture.sent).toEqual(['I can show you how The Timeline works.']);
  const [row] = await sql`SELECT count(*)::int AS count FROM action_intents
    WHERE agent_id=${agentId} AND review_status='pending'`;
  expect(row?.count).toBe(0);
  expect(await outboundFor(agentId)).toMatchObject({ status: 'sent' });
});

test('a global pause after approval blocks the reviewed reply before sending', async () => {
  const { agentId, intent } = await discoverReply('shadow');
  await persistLifecycle(admin, agentId, 'live');
  expect(await reviewProposedAction(admin, agentId, intent.id, 'approved')).toHaveProperty(
    'message',
  );
  expect(await outboundFor(agentId)).toMatchObject({ status: 'queued' });
  await persistGlobalPause(admin, true);
  const job = await claimXReply(agentId);
  const fixture = fixtureXDelivery();
  await processOutboundJob(job, signal, fixture.override);
  await completeJob(job.id, workerId);
  expect(fixture.sent).toHaveLength(0);
  expect(await outboundFor(agentId)).toMatchObject({
    status: 'blocked',
    reason: expect.stringContaining('Global outbound pause'),
  });
});

test.each([
  ['global pause', async () => persistGlobalPause(admin, true), 'Global outbound pause'],
  [
    'agent grant',
    async (id: string) => persistChannelGrant(admin, id, X_REPLY_ACTION, false),
    'not enabled',
  ],
  ['recipient consent', async (id: string) => setXConsent(id, false), 'revoked consent'],
  ['lifecycle', async (id: string) => persistLifecycle(admin, id, 'paused'), 'Agent is paused'],
  [
    'budget',
    async (id: string) => persistBudgets(admin, id, { ...budgetDefaults, dailyOutboundActions: 0 }),
    'outbound-action cap',
  ],
  [
    'current approval requirements',
    async (id: string) =>
      persistApprovalTools(admin, id, 1, {
        approvalTools: [X_REPLY_ACTION],
        approvalSpendCents: null,
        approvalExpiresAfterHours: null,
        approvalOnReject: 'continue',
      }),
    'An administrator must review',
  ],
] as const)('queued X delivery rechecks %s', async (_name, change, reason) => {
  const { agentId } = await discoverReply();
  const job = await claimXReply(agentId);
  await change(agentId);
  const fixture = fixtureXDelivery();
  await processOutboundJob(job, signal, fixture.override);
  await completeJob(job.id, workerId);
  expect(fixture.sent).toHaveLength(0);
  expect(await outboundFor(agentId)).toMatchObject({
    status: 'blocked',
    reason: expect.stringContaining(reason),
  });
});

test('reply requires consent and a real connection for the normal dispatcher', async () => {
  const declined = await discoverReply('live', false);
  expect(declined.intent).toMatchObject({ review_status: null, decision: 'deny' });
  expect(await outboundFor(declined.agentId)).toBeUndefined();
  const { agentId } = await discoverReply();
  const job = await claimXReply(agentId);
  await processOutboundJob(job, signal);
  await completeJob(job.id, workerId);
  expect(await outboundFor(agentId)).toMatchObject({
    status: 'blocked',
    reason: expect.stringContaining('Connect an X user'),
  });
});

test('confirmed X rate limits can retry and an interrupted write cannot', async () => {
  const { agentId } = await discoverReply();
  const first = await claimXReply(agentId);
  const fixture = fixtureXDelivery([{ ok: false, retryable: true, error: 'HTTP 429' }]);
  await expect(processOutboundJob(first, signal, fixture.override)).rejects.toThrow('HTTP 429');
  expect(await outboundFor(agentId)).toMatchObject({ status: 'queued' });
  await failJob(first.id, workerId, 'HTTP 429');
  await sql`UPDATE jobs SET available_at=now() WHERE id=${first.id}`;
  const second = await claimXReply(agentId);
  await processOutboundJob(first, signal, fixture.override);
  await processOutboundJob(second, signal, fixture.override);
  await completeJob(second.id, workerId);
  expect(fixture.sent).toHaveLength(2);
  expect(await outboundFor(agentId)).toMatchObject({ status: 'sent' });

  const interrupted = await discoverReply();
  const claimed = await claimXReply(interrupted.agentId);
  await sql`UPDATE outbound_actions SET status='sending', dispatch_attempt=${claimed.attempts}, dispatched_at=now() WHERE job_id=${claimed.id}`;
  await sql`UPDATE jobs SET claim_expires_at=now() - interval '1 second' WHERE id=${claimed.id}`;
  const recovered = await claimXReply(interrupted.agentId);
  await processOutboundJob(recovered, signal, fixture.override);
  await completeJob(recovered.id, workerId);
  expect(fixture.sent).toHaveLength(2);
  expect(await outboundFor(interrupted.agentId)).toMatchObject({
    status: 'failed',
    reason: expect.stringContaining('could not be confirmed'),
  });
});

test('the worker sends with the agent’s encrypted X token and records the provider reply ID', async () => {
  const originalEncryptionKey = process.env.ORBIT_ENCRYPTION_KEY;
  process.env.ORBIT_ENCRYPTION_KEY = 'a'.repeat(64);
  const provider = spyOn(globalThis, 'fetch');
  try {
    const { agentId } = await discoverReply('live', true, async (id) => {
      const encrypted = encryptSecret(xReplySecretSubject(id), 'fixture-x-user-token');
      await sql`INSERT INTO x_reply_credentials(agent_id,user_id,username,encrypted_token)
        VALUES(${id},'12111','orbit_fixture',${encrypted})`;
    });
    provider.mockImplementation(
      Object.assign(
        (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
          const address = String(url);
          expect(new Headers(init?.headers).get('Authorization')).toBe(
            'Bearer fixture-x-user-token',
          );
          if (address.startsWith('https://api.x.com/2/tweets/1001?')) {
            return Promise.resolve(
              Response.json({
                data: { id: '1001', author_id: '12001', entities: { mentions: [{ id: '12111' }] } },
              }),
            );
          }
          expect(address).toBe('https://api.x.com/2/tweets');
          expect(init?.method).toBe('POST');
          return Promise.resolve(Response.json({ data: { id: '12002' } }, { status: 201 }));
        },
        { preconnect: fetch.preconnect },
      ),
    );
    const job = await claimXReply(agentId);
    await processOutboundJob(job, signal);
    await processOutboundJob(job, signal);
    await completeJob(job.id, workerId);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(await outboundFor(agentId)).toMatchObject({
      status: 'sent',
      provider: 'x-api',
      provider_message_id: '12002',
    });
  } finally {
    provider.mockRestore();
    if (originalEncryptionKey === undefined) delete process.env.ORBIT_ENCRYPTION_KEY;
    else process.env.ORBIT_ENCRYPTION_KEY = originalEncryptionKey;
  }
});
