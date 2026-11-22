import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import postgres from 'postgres';

import { budgetDefaults } from '@/lib/budgets';
import { claimJobs, completeJob, releaseClaim } from '@/lib/queue/jobs';
import {
  CHANNEL_EVENT_JOB,
  ingestChannelEvent,
  processChannelEventJob,
} from '@/lib/runtime/channels/ingest';
import { registerChannel } from '@/lib/runtime/channels/registry';
import {
  EVALUATION_REPLAY_JOB,
  processEvaluationReplayJob,
  saveEvaluationCase,
  startEvaluationComparison,
} from '@/lib/runtime/evaluation';
import { processSimulationJob, SIMULATION_JOB_TYPE } from '@/lib/runtime/execute';
import { processOutboundJob } from '@/lib/runtime/outbound/process';
import { CHANNEL_OUTBOUND_JOB } from '@/lib/runtime/outbound/types';
import { getPersonContextForAgent } from '@/lib/runtime/people/history';
import { encryptCredential } from '@/lib/runtime/secrets';
import type { ModelCall } from '@/lib/runtime/simulation';
import { selectAgentMemoryEvidence } from '@/lib/server/memory-queries';
import { persistChannelGrant, reviewProposedAction } from '@/lib/server/policy-mutations';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://orbit:orbit_dev@localhost:5432/orbit_test';
const sql = postgres(databaseUrl);
const ids: string[] = [];
const admin = 'channel-test@example.test';
const workerId = 'fixture-channel-worker';
const channel = 'fixture-chat';
const actionType = 'fixture-chat.reply';
const requirement = 'Northstar requires SSO for the pilot.';
const signal = new AbortController().signal;
const budgets = { ...budgetDefaults, dailySpendCents: null, monthlySpendCents: null };

afterAll(async () => {
  try {
    for (const id of ids) {
      await sql`DELETE FROM evaluation_comparisons WHERE agent_id=${id}`;
      await sql`DELETE FROM evaluation_cases WHERE agent_id=${id}`;
      await sql`DELETE FROM outbound_actions WHERE agent_id=${id}`;
      await sql`DELETE FROM policy_decisions WHERE agent_id=${id}`;
      await sql`DELETE FROM action_intents WHERE agent_id=${id}`;
      await sql`DELETE FROM usage_counters WHERE agent_id=${id}`;
      await sql`DELETE FROM source_events WHERE agent_id=${id}`;
      await sql`DELETE FROM simulation_runs WHERE agent_id=${id}`;
      await sql`DELETE FROM jobs WHERE payload->>'agentId'=${id}`;
      await sql`DELETE FROM agent_credentials WHERE agent_id=${id}`;
      await sql`DELETE FROM agent_configurations WHERE agent_id=${id}`;
      await sql`DELETE FROM agents WHERE id=${id}`;
    }
  } finally {
    await sql.end();
  }
});

async function seedAgent(enabledTools: string[]) {
  const id = randomUUID();
  ids.push(id);
  await sql`INSERT INTO agents (id, name, mission, lifecycle, budgets, enabled_tools)
    VALUES (${id}, 'Channel fixture', 'Help with pilots', 'live', ${sql.json(budgets)}, ${sql.json(enabledTools)})`;
  const config = {
    name: 'Channel fixture',
    mission: 'Help with pilots',
    mainModel: 'fixture/main',
    evaluatorModel: 'fixture/eval',
  };
  const [first, second] = await sql<{ id: string }[]>`
    INSERT INTO agent_configurations (agent_id, version, config, actor)
    VALUES (${id}, 1, ${sql.json(config)}, ${admin}), (${id}, 2, ${sql.json(config)}, ${admin})
    RETURNING id`;
  await sql`INSERT INTO agent_credentials VALUES (${id}, ${encryptCredential(id, 'fixture-only')})`;
  return { id, first: first!.id, second: second!.id };
}

async function claim(type: string, agentId: string) {
  const claimed = (await claimJobs({ workerId, limit: 20, types: [type] })).find(
    (job) => job.payload.agentId === agentId,
  );
  expect(claimed).toBeDefined();
  return claimed!;
}

test('a new channel uses shared intake, policy, dispatch, memory, People and replay', async () => {
  const deliveries: Array<{ body: string; key: string }> = [];
  const unregister = registerChannel({
    id: channel,
    label: 'Fixture chat',
    run: { mode: 'evaluate' },
    actions: [
      {
        type: actionType,
        provider: channel,
        alwaysRequiresApproval: true,
        async prepareDelivery(_tx, outbound, intent) {
          return {
            recipients: intent.recipients,
            async send() {
              deliveries.push({ body: outbound.body, key: outbound.idempotencyKey });
              return { ok: true, id: 'fixture-delivery', raw: {} };
            },
          };
        },
      },
    ],
  });
  const [controls] = await sql`SELECT paused FROM controls WHERE id=1`;
  const encryptionKey = process.env.ORBIT_ENCRYPTION_KEY;
  try {
    process.env.ORBIT_ENCRYPTION_KEY = 'a'.repeat(64);
    await sql`UPDATE controls SET paused=false WHERE id=1`;
    const owner = await seedAgent([]);
    const other = await seedAgent([]);
    expect(await persistChannelGrant(admin, owner.id, actionType, true)).toHaveProperty('message');
    const author = randomUUID();
    const inbound = {
      agentId: owner.id,
      channel,
      externalId: 'message-1',
      text: requirement,
      authorId: author,
      authorName: 'Northstar admin',
      recipients: [author],
    };
    const received = await ingestChannelEvent(inbound);
    expect(received).not.toBeNull();
    expect(await ingestChannelEvent(inbound)).toBeNull();
    const receivedJob = await claim(CHANNEL_EVENT_JOB, owner.id);
    await processChannelEventJob(receivedJob);
    await processChannelEventJob(receivedJob);
    await completeJob(receivedJob.id, workerId);
    const [source] =
      await sql`SELECT run_id, person_identity_id FROM source_events WHERE id=${received!.sourceId}`;
    const [identity] =
      await sql`SELECT channel, person_id FROM person_identities WHERE id=${source!.person_identity_id}`;
    expect(identity?.channel).toBe(channel);
    expect(await sql`SELECT id FROM simulation_runs WHERE agent_id=${owner.id}`).toHaveLength(1);

    const model: ModelCall = async (request) => {
      expect(request.actionTypes).toContain(actionType);
      return {
        decision: {
          relevant: true,
          priority: 1,
          reason: 'Pilot requirement',
          ...(request.grounded ? { answer: null, citations: [], memoryCitations: [] } : {}),
          actions: [
            {
              type: actionType,
              reason: 'Acknowledge requirement',
              draft: 'Thanks. We support SSO.',
            },
          ],
        },
        relationshipNote: { summary: requirement, excerpt: requirement },
        memoryCandidates: [
          {
            subjectKind: 'company',
            subject: 'Northstar',
            topic: 'SSO requirement',
            fact: requirement,
            quote: requirement,
          },
        ],
        inputTokens: 3,
        outputTokens: 5,
        costMicros: 0,
      };
    };
    const runJob = await claim(SIMULATION_JOB_TYPE, owner.id);
    await processSimulationJob(runJob.payload, () => model, signal, { jobId: runJob.id, workerId });
    const [run] =
      await sql`SELECT status, channel, origin FROM simulation_runs WHERE id=${source!.run_id}`;
    expect(run).toMatchObject({ status: 'awaiting_approval', channel, origin: 'channel' });
    const [intent] =
      await sql`SELECT id FROM action_intents WHERE run_id=${source!.run_id} AND review_status='pending'`;
    expect(intent).toBeDefined();
    expect(await sql`SELECT id FROM outbound_actions WHERE agent_id=${owner.id}`).toHaveLength(0);
    expect(await reviewProposedAction(admin, other.id, intent!.id, 'approved')).toHaveProperty(
      'error',
    );
    expect(await reviewProposedAction(admin, owner.id, intent!.id, 'approved')).toMatchObject({
      message: expect.stringContaining('queued'),
    });
    const resumedJob = await claim(SIMULATION_JOB_TYPE, owner.id);
    await processSimulationJob(
      resumedJob.payload,
      () => async () => {
        throw new Error('Approval should resume without another paid model call.');
      },
      signal,
      { jobId: resumedJob.id, workerId },
    );
    await completeJob(resumedJob.id, workerId);
    const [completed] = await sql`SELECT status FROM simulation_runs WHERE id=${source!.run_id}`;
    expect(completed?.status).toBe('completed');
    const sendJob = await claim(CHANNEL_OUTBOUND_JOB, owner.id);
    await processOutboundJob(sendJob, signal);
    await processOutboundJob(sendJob, signal);
    await completeJob(sendJob.id, workerId);
    expect(deliveries).toEqual([{ body: 'Thanks. We support SSO.', key: expect.any(String) }]);
    const [delivery] =
      await sql`SELECT status, provider_message_id FROM outbound_actions WHERE intent_id=${intent!.id}`;
    expect(delivery).toMatchObject({ status: 'sent', provider_message_id: 'fixture-delivery' });

    const history = await getPersonContextForAgent(owner.id, identity!.person_id);
    expect(history.interactions.map(({ channel, sent }) => ({ channel, sent }))).toEqual([
      { channel, sent: true },
      { channel, sent: false },
    ]);
    expect([...history.notes]).toEqual([expect.objectContaining({ excerpt: requirement })]);
    expect((await getPersonContextForAgent(other.id, identity!.person_id)).interactions).toEqual(
      [],
    );
    const memories =
      await sql`SELECT id, revision, source_id FROM agent_memories WHERE agent_id=${owner.id}`;
    expect(memories).toHaveLength(1);
    expect(memories[0]?.source_id).toBe(received!.sourceId);
    expect(
      await selectAgentMemoryEvidence(owner.id, memories[0]!.id, memories[0]!.revision),
    ).toMatchObject({ quote: requirement, source: { id: received!.sourceId } });
    expect(
      await selectAgentMemoryEvidence(other.id, memories[0]!.id, memories[0]!.revision),
    ).toBeNull();

    const later = await ingestChannelEvent({
      ...inbound,
      externalId: 'message-2',
      text: 'Does the Northstar pilot require SSO?',
    });
    const laterJob = await claim(CHANNEL_EVENT_JOB, owner.id);
    await processChannelEventJob(laterJob);
    await completeJob(laterJob.id, workerId);
    const recallJob = await claim(SIMULATION_JOB_TYPE, owner.id);
    const recalled: string[] = [];
    await processSimulationJob(
      recallJob.payload,
      () => async (request) => {
        const context: { untrustedMemories?: { fact: string }[] } = JSON.parse(request.input);
        recalled.push(...(context.untrustedMemories ?? []).map(({ fact }) => fact));
        return {
          decision: { relevant: true, priority: 1, reason: 'Follow-up', actions: [] },
          memoryCandidates: [],
          inputTokens: 3,
          outputTokens: 5,
          costMicros: 0,
        };
      },
      signal,
      { jobId: recallJob.id, workerId },
    );
    await completeJob(recallJob.id, workerId);
    expect(later).not.toBeNull();
    expect(recalled).toContain(requirement);

    const savedInput = {
      actor: admin,
      title: 'Pilot requirement',
      sourceKind: 'channel' as const,
      sourceRunId: source!.run_id,
      caseInput: '',
    };
    expect(await saveEvaluationCase({ ...savedInput, agentId: other.id })).toHaveProperty('error');
    const saved = await saveEvaluationCase({ ...savedInput, agentId: owner.id });
    if (!('caseId' in saved)) throw new Error(saved.error);
    const [savedCase] =
      await sql`SELECT source_channel, input FROM evaluation_cases WHERE id=${saved.caseId}`;
    expect(savedCase).toMatchObject({ source_channel: channel, input: requirement });
    const started = await startEvaluationComparison({
      actor: admin,
      agentId: owner.id,
      caseId: saved.caseId,
      leftConfigurationId: owner.first,
      rightConfigurationId: owner.second,
    });
    if (!('comparisonId' in started)) throw new Error(started.error);
    const replayJob = await claim(EVALUATION_REPLAY_JOB, owner.id);
    await processEvaluationReplayJob(replayJob.payload, () => model, signal, {
      jobId: replayJob.id,
      workerId,
      jobType: EVALUATION_REPLAY_JOB,
    });
    await completeJob(replayJob.id, workerId);
    const replays =
      await sql`SELECT channel, status FROM simulation_runs WHERE agent_id=${owner.id} AND origin='replay'`;
    expect([...replays]).toEqual([
      { channel, status: 'completed' },
      { channel, status: 'completed' },
    ]);
    const replayPolicy =
      await sql`SELECT decision FROM action_intents JOIN simulation_runs r ON r.id=run_id
        WHERE r.agent_id=${owner.id} AND r.origin='replay' AND action_type=${actionType}`;
    expect(replayPolicy.length).toBeGreaterThan(0);
    expect(replayPolicy.every(({ decision }) => decision === 'suppressed')).toBe(true);
    expect(await sql`SELECT id FROM outbound_actions WHERE agent_id=${owner.id}`).toHaveLength(1);
    expect(await sql`SELECT id FROM agent_memories WHERE agent_id=${owner.id}`).toHaveLength(1);

    const otherEvent = await ingestChannelEvent({ ...inbound, agentId: other.id });
    const otherIntake = await claim(CHANNEL_EVENT_JOB, other.id);
    await processChannelEventJob(otherIntake);
    await completeJob(otherIntake.id, workerId);
    const otherRun = await claim(SIMULATION_JOB_TYPE, other.id);
    await processSimulationJob(otherRun.payload, () => model, signal, {
      jobId: otherRun.id,
      workerId,
    });
    await completeJob(otherRun.id, workerId);
    const decisions = await sql`SELECT intent.decision, intent.reasons
      FROM action_intents intent JOIN source_events event ON event.run_id=intent.run_id
      WHERE event.id=${otherEvent!.sourceId} AND intent.action_type=${actionType}`;
    expect(decisions.length).toBeGreaterThan(0);
    for (const decision of decisions) {
      expect(decision).toMatchObject({
        decision: 'deny',
        reasons: [expect.stringContaining('not enabled')],
      });
    }
    expect(await sql`SELECT id FROM outbound_actions WHERE agent_id=${other.id}`).toHaveLength(0);
  } finally {
    unregister();
    await sql`UPDATE controls SET paused=${controls?.paused ?? true} WHERE id=1`;
    if (encryptionKey === undefined) delete process.env.ORBIT_ENCRYPTION_KEY;
    else process.env.ORBIT_ENCRYPTION_KEY = encryptionKey;
  }
});

test('accepted channel events retry admission when quota returns and persist rejection reasons', async () => {
  const unregister = registerChannel({
    id: channel,
    label: 'Fixture chat',
    run: { mode: 'draft' },
  });
  const encryptionKey = process.env.ORBIT_ENCRYPTION_KEY;
  try {
    process.env.ORBIT_ENCRYPTION_KEY = 'a'.repeat(64);
    const agent = await seedAgent([]);
    const inbound = {
      agentId: agent.id,
      channel,
      externalId: 'deferred',
      text: 'Please follow up.',
    };
    await sql`UPDATE agents SET budgets=${sql.json({ ...budgets, dailyRequests: 0 })} WHERE id=${agent.id}`;
    const event = (await ingestChannelEvent(inbound))!;
    const claimed = await claim(CHANNEL_EVENT_JOB, agent.id);
    const deferred = await processChannelEventJob(claimed);
    expect(deferred?.deferUntil.getTime()).toBeGreaterThan(Date.now());
    const [waiting] =
      await sql`SELECT run_id,admission_status,admission_reason FROM source_events WHERE id=${event.sourceId}`;
    expect(waiting).toEqual({
      run_id: null,
      admission_status: 'deferred',
      admission_reason: 'Daily request quota reached. Work was deferred.',
    });
    // Release as the worker does. Advance the retry date in the fixture.
    expect(await releaseClaim(claimed.id, workerId, undefined, deferred!.deferUntil)).toMatchObject(
      {
        status: 'pending',
        attempts: 0,
      },
    );
    await sql`UPDATE agents SET budgets=${sql.json(budgets)} WHERE id=${agent.id}`;
    await sql`UPDATE jobs SET available_at=now() WHERE id=${claimed.id}`;
    expect(await ingestChannelEvent(inbound)).toBeNull();
    const retry = await claim(CHANNEL_EVENT_JOB, agent.id);
    await processChannelEventJob(retry);
    await processChannelEventJob(retry);
    await completeJob(retry.id, workerId);
    const [admitted] =
      await sql`SELECT run_id,admission_status,admission_reason FROM source_events WHERE id=${event.sourceId}`;
    expect(admitted).toEqual({
      run_id: expect.any(String),
      admission_status: 'admitted',
      admission_reason: null,
    });
    expect(await sql`SELECT id FROM simulation_runs WHERE agent_id=${agent.id}`).toHaveLength(1);

    const rejected = (await ingestChannelEvent({ ...inbound, externalId: 'unavailable' }))!;
    await sql`UPDATE simulation_runs SET status='completed' WHERE id=${admitted!.run_id}`;
    await sql`UPDATE jobs SET payload=payload || ${sql.json({ configurationId: randomUUID() })}
      WHERE id=${rejected.jobId}`;
    const missing = await claim(CHANNEL_EVENT_JOB, agent.id);
    expect(await processChannelEventJob(missing)).toBeUndefined();
    await completeJob(missing.id, workerId);
    const [recorded] =
      await sql`SELECT run_id,admission_status,admission_reason FROM source_events WHERE id=${rejected.sourceId}`;
    expect(recorded).toEqual({
      run_id: null,
      admission_status: 'rejected',
      admission_reason: 'The configuration is unavailable. Refresh and try again.',
    });
  } finally {
    unregister();
    if (encryptionKey === undefined) delete process.env.ORBIT_ENCRYPTION_KEY;
    else process.env.ORBIT_ENCRYPTION_KEY = encryptionKey;
  }
});

test('a channel run keeps conversation context within its own agent, account and thread', async () => {
  const unregister = registerChannel({
    id: channel,
    label: 'Fixture chat',
    run: { mode: 'draft' },
  });
  const encryptionKey = process.env.ORBIT_ENCRYPTION_KEY;
  try {
    process.env.ORBIT_ENCRYPTION_KEY = 'a'.repeat(64);
    const agent = await seedAgent([]);
    const other = await seedAgent([]);
    const inbound = {
      agentId: agent.id,
      channel,
      accountId: 'workspace-a',
      threadId: 'pilot',
      externalId: '1',
      text: 'The pilot starts Friday.',
      authorId: randomUUID(),
      authorName: 'Riley',
    };
    for (const event of [
      inbound,
      { ...inbound, externalId: '2', threadId: 'billing', text: 'Billing thread secret' },
      { ...inbound, accountId: 'workspace-b', text: 'Other account secret' },
      { ...inbound, agentId: other.id, text: 'Other agent secret' },
    ]) {
      const source = await ingestChannelEvent(event);
      expect(source).not.toBeNull();
      // Mark the prior event admitted so both conversation and person history would see it.
      const [run] =
        await sql`INSERT INTO simulation_runs (agent_id,configuration_id,actor,input,origin,channel,status,result,expires_at)
        VALUES (${event.agentId}, ${event.agentId === agent.id ? agent.second : other.second}, ${admin}, ${event.text},
          'channel', ${channel}, 'completed', '{"steps":[],"actions":[],"error":null}', now()) RETURNING id`;
      await sql`UPDATE source_events SET run_id=${run!.id},admission_status='admitted' WHERE id=${source!.sourceId}`;
      await sql`UPDATE jobs SET status='completed' WHERE id=${source!.jobId}`;
    }
    const now = (await ingestChannelEvent({
      ...inbound,
      externalId: '3',
      text: 'When does it start?',
    }))!;
    const intake = await claim(CHANNEL_EVENT_JOB, agent.id);
    await processChannelEventJob(intake);
    await completeJob(intake.id, workerId);
    const [source] = await sql`SELECT run_id FROM source_events WHERE id=${now.sourceId}`;
    const runJob = await claim(SIMULATION_JOB_TYPE, agent.id);
    const stages: string[] = [];
    const model: ModelCall = async (request) => {
      stages.push(request.stage!);
      const input = JSON.parse(request.input);
      expect(input.untrustedChannelThread).toEqual([{ author: 'Riley', text: inbound.text }]);
      expect(input.untrustedInput).toBe('When does it start?');
      expect(request.input).not.toContain('secret');
      return {
        decision: {
          relevant: true,
          priority: 1,
          reason: 'Pilot',
          actions: [],
          answer: 'Friday',
          citations: [],
        },
        inputTokens: 1,
        outputTokens: 1,
        costMicros: 0,
      };
    };
    await processSimulationJob(runJob.payload, () => model, signal, { jobId: runJob.id, workerId });
    expect(stages).toEqual(['evaluator', 'main']);
    const [result] = await sql`SELECT status FROM simulation_runs WHERE id=${source!.run_id}`;
    expect(result).toEqual({ status: 'completed' });
    const [identity] = await sql`SELECT person_id FROM person_identities WHERE channel=${channel}
      AND identity_key=${inbound.authorId}`;
    const history = await getPersonContextForAgent(agent.id, identity!.person_id);
    expect(
      history.interactions.filter(({ title }) =>
        [inbound.text, 'Other account secret'].includes(title),
      ),
    ).toHaveLength(2);
  } finally {
    unregister();
    if (encryptionKey === undefined) delete process.env.ORBIT_ENCRYPTION_KEY;
    else process.env.ORBIT_ENCRYPTION_KEY = encryptionKey;
  }
});
