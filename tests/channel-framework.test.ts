import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import postgres from 'postgres';

import { budgetDefaults } from '@/lib/budgets';
import { claimJobs, completeJob } from '@/lib/queue/jobs';
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
import {
  MEMORY_MAINTENANCE_JOB,
  processMemoryMaintenance,
  scheduleMemoryMaintenance,
} from '@/lib/runtime/memory/retention';
import { processOutboundJob } from '@/lib/runtime/outbound/process';
import { CHANNEL_OUTBOUND_JOB } from '@/lib/runtime/outbound/types';
import { getPersonContextForAgent } from '@/lib/runtime/people/history';
import { encryptCredential } from '@/lib/runtime/secrets';
import type { ModelCall } from '@/lib/runtime/simulation';
import { saveMemoryRetention } from '@/lib/server/memory-mutations';
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
      await sql`SELECT id, status, provider_message_id FROM outbound_actions WHERE intent_id=${intent!.id}`;
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
      await sql`SELECT id, revision, source_id FROM agent_memories WHERE agent_id=${owner.id} AND subject_kind='company'`;
    expect(memories).toHaveLength(1);
    expect(memories[0]?.source_id).toBe(received!.sourceId);
    expect(
      await selectAgentMemoryEvidence(owner.id, memories[0]!.id, memories[0]!.revision),
    ).toMatchObject({ quote: requirement, source: { id: received!.sourceId } });
    expect(
      await selectAgentMemoryEvidence(other.id, memories[0]!.id, memories[0]!.revision),
    ).toBeNull();

    const [outcome] = await sql`SELECT id, revision FROM agent_memories
      WHERE agent_id=${owner.id} AND subject_kind='outcome'`;
    expect(await selectAgentMemoryEvidence(owner.id, outcome!.id, outcome!.revision)).toMatchObject(
      {
        quote: 'Delivery confirmed (fixture-chat.reply).',
        source: { id: delivery!.id, label: 'Recorded delivery' },
      },
    );
    expect(await selectAgentMemoryEvidence(other.id, outcome!.id, outcome!.revision)).toBeNull();

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
    expect(await sql`SELECT id FROM agent_memories WHERE agent_id=${owner.id}`).toHaveLength(2);

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
    await sql`UPDATE agent_memories SET learned_at=now()-interval '2 days' WHERE agent_id IN (${owner.id},${other.id})`;
    await sql`UPDATE person_relationship_notes SET created_at=now()-interval '2 days' WHERE agent_id=${owner.id}`;
    expect(
      await saveMemoryRetention(admin, owner.id, {
        factDays: null,
        noteDays: 1,
        outcomeDays: 1,
        intervalDays: 7,
      }),
    ).toHaveProperty('message');
    await Promise.all([scheduleMemoryMaintenance(), scheduleMemoryMaintenance()]);
    const maintenance = await claim(MEMORY_MAINTENANCE_JOB, owner.id);
    expect(
      await sql`SELECT id FROM jobs WHERE type=${MEMORY_MAINTENANCE_JOB} AND payload->>'agentId'=${owner.id}`,
    ).toHaveLength(1);
    await processMemoryMaintenance(owner.id);
    await processMemoryMaintenance(owner.id);
    await completeJob(maintenance.id, workerId);
    expect([
      ...(await sql`SELECT subject_kind FROM agent_memories WHERE agent_id=${owner.id}`),
    ]).toEqual([{ subject_kind: 'company' }]);
    expect([
      ...(await sql`SELECT subject_kind FROM agent_memories WHERE agent_id=${other.id}`),
    ]).toEqual([{ subject_kind: 'company' }]);
    expect(
      await sql`SELECT 1 FROM person_relationship_notes WHERE agent_id=${owner.id}`,
    ).toHaveLength(0);
    expect(await sql`SELECT 1 FROM outbound_actions WHERE id=${delivery!.id}`).toHaveLength(1);
    expect(
      await sql`SELECT 1 FROM agents WHERE id=${owner.id} AND memory_next_maintenance_at > now()+interval '6 days'`,
    ).toHaveLength(1);
  } finally {
    unregister();
    await sql`UPDATE controls SET paused=${controls?.paused ?? true} WHERE id=1`;
    if (encryptionKey === undefined) delete process.env.ORBIT_ENCRYPTION_KEY;
    else process.env.ORBIT_ENCRYPTION_KEY = encryptionKey;
  }
});
