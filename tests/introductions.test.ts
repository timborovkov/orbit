import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import postgres from 'postgres';

import { budgetDefaults } from '@/lib/budgets';
import { db } from '@/lib/db';
import { recipientConsentFailure } from '@/lib/policy/consent';
import { authorizeAction, loadPolicyContext } from '@/lib/policy/gateway';
import { claimJobs, completeJob, failJob } from '@/lib/queue/jobs';
import { lockApprovalAgent } from '@/lib/runtime/approval-work';
import {
  introductionEmailDisclosure,
  prepareIntroductionDelivery,
} from '@/lib/runtime/email/introduction';
import { createStubEmailTransport, type EmailTransport } from '@/lib/runtime/email/transport';
import { enqueueSimulation, processSimulationJob } from '@/lib/runtime/execute';
import { introductionDisclosureFailure } from '@/lib/runtime/introductions/disclosure';
import {
  INTRODUCTION_REVIEW,
  type IntroductionDecision,
  PEOPLE_INTRODUCE,
  PEOPLE_SEARCH,
} from '@/lib/runtime/introductions/types';
import { enqueueOutbound } from '@/lib/runtime/outbound/dispatch';
import { processOutboundJob } from '@/lib/runtime/outbound/process';
import { CHANNEL_OUTBOUND_JOB, EMAIL_INTRODUCTION_ACTION } from '@/lib/runtime/outbound/types';
import { getPersonContextForAgent } from '@/lib/runtime/people/history';
import type { ModelCall } from '@/lib/runtime/simulation';
import { type actionIntents, introductionProposals } from '@/lib/schema';
import { persistPeopleGrant, recordIntroductionConsent } from '@/lib/server/introduction-mutations';
import { removePersonLink, savePersonLink } from '@/lib/server/people-mutations';
import {
  persistChannelGrant,
  recordConsent,
  reviewProposedAction,
} from '@/lib/server/policy-mutations';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://orbit:orbit_dev@localhost:5432/orbit_test';
const sql = postgres(databaseUrl);
const actor = 'introductions-fixture@example.test';
const fixtureAgents: string[] = [];
const identities: string[] = [];
const signal = new AbortController().signal;
const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
};

beforeAll(() => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.OPENROUTER_API_KEY = 'fixture-key';
});

afterAll(async () => {
  try {
    if (fixtureAgents.length) {
      await sql`delete from outbound_actions where agent_id in ${sql(fixtureAgents)}`;
      await sql`delete from policy_decisions where agent_id in ${sql(fixtureAgents)}`;
      await sql`delete from action_intents where agent_id in ${sql(fixtureAgents)}`;
      await sql`delete from usage_counters where agent_id in ${sql(fixtureAgents)}`;
      await sql`delete from simulation_runs where agent_id in ${sql(fixtureAgents)}`;
      await sql`delete from jobs where payload->>'agentId' in ${sql(fixtureAgents)}`;
      await sql`delete from agent_configurations where agent_id in ${sql(fixtureAgents)}`;
      await sql`delete from agents where id in ${sql(fixtureAgents)}`;
      await sql`delete from audit where actor = ${actor}`;
    }
    if (identities.length) {
      const people = await sql<{ person_id: string; home_person_id: string }[]>`
        select person_id, home_person_id from person_identities where id in ${sql(identities)}
      `;
      await sql`delete from person_link_rejections where first_identity_id in ${sql(identities)} or second_identity_id in ${sql(identities)}`;
      await sql`delete from person_identity_changes where identity_id in ${sql(identities)}`;
      await sql`delete from person_identities where id in ${sql(identities)}`;
      await sql`delete from people where id in ${sql([
        ...new Set(people.flatMap(({ person_id, home_person_id }) => [person_id, home_person_id])),
      ])}`;
    }
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await sql.end();
  }
});

async function fixtureAgent(template: 'superconnector' | 'support', grants = true) {
  const id = randomUUID();
  fixtureAgents.push(id);
  const name = template === 'superconnector' ? 'Maya' : 'Sarah';
  await sql`insert into agents (id, name, mission, budgets, enabled_tools)
    values (${id}, ${name}, 'Propose mutually useful matches',
      ${sql.json({ ...budgetDefaults, dailySpendCents: null, monthlySpendCents: null })},
      ${sql.json(grants ? [PEOPLE_SEARCH, PEOPLE_INTRODUCE] : [])})`;
  const [config] = await sql<
    { id: string }[]
  >`insert into agent_configurations (agent_id, version, config, actor)
    select ${id}, 1, config || jsonb_build_object('name', ${name}::text), ${actor}
    from templates where templates.id = ${template} returning id`;
  return { id, configurationId: config.id };
}

async function observe(agentId: string, name: string, text = 'Fixture interaction.') {
  const [row] = await sql<{ id: string; person_identity_id: string }[]>`
    insert into source_events (agent_id, provider, provider_event_id, payload, text, author_id, author_name)
    values (${agentId}, 'x', ${randomUUID()}, '{}', ${text}, ${randomUUID()}, ${name})
    returning id, person_identity_id
  `;
  identities.push(row.person_identity_id);
  const [identity] = await sql<{ person_id: string; revision: number }[]>`
    select person_id, revision from person_identities where id = ${row.person_identity_id}
  `;
  return {
    sourceId: row.id,
    identityId: row.person_identity_id,
    personId: identity.person_id,
    revision: identity.revision,
  };
}

type Agent = Awaited<ReturnType<typeof fixtureAgent>>;
type Observed = Awaited<ReturnType<typeof observe>>;

async function propose(
  agent: Agent,
  first: Observed,
  second: Observed,
  expectAccess = true,
  expectTools = true,
  legacy = true,
) {
  const { runId } = await enqueueSimulation({
    actor,
    agentId: agent.id,
    configurationId: agent.configurationId,
    input: 'Find an introduction to help a team design its agent evaluations.',
  });
  if (!runId) throw new Error('Expected a queued run');
  let introductionId: string | undefined;
  let search: unknown;
  const requests: string[] = [];
  const model: ModelCall = async (request) => {
    requests.push(request.input);
    if (request.stage === 'main') {
      const opts = { toolCallId: 'fixture', messages: [], context: undefined };
      const find = request.tools?.search_people.execute;
      const create = request.tools?.propose_introduction.execute;
      expect(Boolean(find && create)).toBe(expectTools);
      if (find && create) {
        search = await find({ query: '' }, opts);
        const scope = {
          first: { personId: first.personId, blurb: 'Can help design agent evaluations.' },
          second: { personId: second.personId, blurb: 'Is setting up support evaluations.' },
          rationale: 'Their evaluation work is complementary.',
        };
        const result = await create(scope, opts);
        expect(result).toHaveProperty(expectAccess ? 'introductionId' : 'error');
        if (
          result &&
          typeof result === 'object' &&
          'introductionId' in result &&
          typeof result.introductionId === 'string'
        ) {
          introductionId = result.introductionId;
          expect(await create(scope, opts)).toEqual(result);
        }
      }
    }
    return {
      decision: {
        relevant: true,
        priority: 1,
        reason: 'An introduction fits.',
        actions:
          request.stage === 'main' && expectTools
            ? [{ type: 'introduce', reason: 'A redundant legacy candidate', draft: null }]
            : [],
      },
      inputTokens: 3,
      outputTokens: 3,
      costMicros: 0,
    };
  };
  await processSimulationJob({ runId }, () => model);
  const [run] = await sql<{ status: string; result: { error: string | null } }[]>`
    select status, result from simulation_runs where id = ${runId}
  `;
  expect(run.result.error).toBeNull();
  expect(run.status).toBe('completed');
  if (expectTools) {
    const [legacy] = await sql`select decision, review_status from action_intents
      where run_id = ${runId} and action_type = 'introduce'`;
    expect(legacy).toMatchObject({ decision: 'deny', review_status: null });
  }
  expect(Boolean(introductionId)).toBe(expectAccess);
  if (legacy && introductionId) {
    await sql`update introduction_proposals set disclosure_version = 1 where id = ${introductionId}`;
  }
  return { introductionId, search, requests, runId };
}

function consent(
  introductionId: string,
  personId: string,
  decision: IntroductionDecision,
  disclosureDigest?: string,
) {
  return recordIntroductionConsent({
    actor,
    introductionId,
    personId,
    decision,
    evidence: 'Fixture decision on the displayed disclosure.',
    disclosureDigest,
  });
}

async function reviewId(id: string) {
  const [row] = await sql<{ review_intent_id: string | null }[]>`select review_intent_id
    from introduction_proposals where id = ${id}`;
  return row.review_intent_id;
}

async function reviewIntent(intentId: string) {
  const [row] = await sql<(typeof actionIntents.$inferSelect)[]>`
    select id, agent_id as "agentId", run_id as "runId", action_type as "actionType",
      recipients, payload, review_status as "reviewStatus", decision,
      idempotency_key as "idempotencyKey"
    from action_intents where id = ${intentId}
  `;
  return row;
}

test('Legacy approval remains review-only and preserves revocation history', async () => {
  const maya = await fixtureAgent('superconnector');
  const alex = await observeEmail(maya.id, 'Alex Chen', `alex-${maya.id}@example.test`);
  const priya = await observeEmail(maya.id, 'Priya Patel', `priya-${maya.id}@example.test`);
  const { introductionId: id } = await propose(maya, alex, priya);
  const { introductionId: otherId } = await propose(maya, alex, priya);
  if (!id || !otherId) throw new Error('Missing Maya proposals');
  expect(id).not.toBe(otherId);

  for (const { personId } of [alex, priya]) {
    expect(
      await recordConsent({
        actor,
        agentId: maya.id,
        recipient: personId,
        scope: 'introduce',
        granted: true,
        evidence: 'Separate legacy scenario consent.',
      }),
    ).toHaveProperty('message');
  }
  expect(await reviewId(id)).toBeNull();
  expect(await consent(id, alex.personId, 'agreed')).toHaveProperty(
    'message',
    'Agreement recorded.',
  );
  expect(await reviewId(id)).toBeNull();
  expect(await consent(otherId, priya.personId, 'agreed')).toHaveProperty('message');
  expect(await reviewId(id)).toBeNull();
  expect(await reviewId(otherId)).toBeNull();

  expect(await consent(id, priya.personId, 'agreed')).toHaveProperty(
    'message',
    'Both people agreed. Draft ready for review.',
  );
  const intentId = await reviewId(id);
  if (!intentId) throw new Error('Missing introduction review');
  const intent = await reviewIntent(intentId);
  expect(intent.actionType).toBe(INTRODUCTION_REVIEW);
  expect(intent.payload).not.toHaveProperty('to');
  expect(intent.runId).toBeNull();
  expect(intent.payload.draft).toContain('Alex Chen — Can help design agent evaluations.');
  expect(intent.payload.draft).toContain('Priya Patel — Is setting up support evaluations.');
  expect(intent.payload.draft).not.toContain('Their evaluation work is complementary.');
  expect(
    await reviewProposedAction(actor, maya.id, intentId, 'approved', {
      editedPayload: { draft: 'Different disclosure' },
    }),
  ).toHaveProperty('error');

  const check = (review = intent) =>
    db().transaction(async (tx) => {
      await lockApprovalAgent(tx, maya.id);
      return introductionDisclosureFailure(tx, review);
    });
  expect(await reviewProposedAction(actor, maya.id, intentId, 'approved')).toHaveProperty(
    'message',
    'Proposal approved.',
  );
  const approved = await reviewIntent(intentId);
  expect(approved.reviewStatus).toBe('approved');
  expect(approved.decision).toBe('suppressed');
  expect(await sql`select id from outbound_actions where intent_id = ${intentId}`).toHaveLength(0);
  expect(await check(approved)).toBeNull();

  const outbound = await db().transaction(async (tx) => {
    await lockApprovalAgent(tx, maya.id);
    return enqueueOutbound(tx, { ...approved, decision: 'allow' }, actor);
  });
  expect(outbound).toBeNull();
  expect(await consent(id, alex.personId, 'revoked')).toHaveProperty('message', 'Consent revoked.');
  expect(await check(approved)).toMatch(/currently agree/);
  const [history] = await sql`select review_status from action_intents where id = ${intentId}`;
  expect(history.review_status).toBe('approved');
});

test('refusal and pending revocation block progression and concurrent agreement produces one draft', async () => {
  const maya = await fixtureAgent('superconnector');
  const alex = await observe(maya.id, 'Alex Chen');
  const priya = await observe(maya.id, 'Priya Patel');
  const { introductionId: refused } = await propose(maya, alex, priya);
  const { introductionId: reviewable } = await propose(maya, alex, priya);
  if (!refused || !reviewable) throw new Error('Missing Maya proposals');

  expect(await consent(refused, alex.personId, 'declined')).toHaveProperty('message');
  expect(await consent(refused, priya.personId, 'agreed')).toHaveProperty('message');
  expect(await consent(refused, alex.personId, 'agreed')).toHaveProperty('error');
  expect(await reviewId(refused)).toBeNull();
  const broad = await db().transaction((tx) =>
    recipientConsentFailure(
      tx,
      maya.id,
      'introduce',
      [alex.personId, priya.personId],
      ['introduce'],
    ),
  );
  expect(broad).toMatch(/Current consent/);

  const outcomes = await Promise.all([
    consent(reviewable, alex.personId, 'agreed'),
    consent(reviewable, priya.personId, 'agreed'),
    consent(reviewable, priya.personId, 'agreed'),
  ]);
  expect(outcomes.every((outcome) => outcome.message)).toBe(true);
  expect(
    await sql`select id from action_intents where idempotency_key = ${`introduction-review:${reviewable}`}`,
  ).toHaveLength(1);
  const intentId = await reviewId(reviewable);
  if (!intentId) throw new Error('Missing review');
  expect(await consent(reviewable, priya.personId, 'revoked')).toHaveProperty('message');
  expect(await reviewProposedAction(actor, maya.id, intentId, 'approved')).toHaveProperty('error');
  const [review] = await sql`select review_status from action_intents where id = ${intentId}`;
  expect(review.review_status).toBe('rejected');
});

test('linked identities preserve agent-owned observations and private history boundaries', async () => {
  const maya = await fixtureAgent('superconnector');
  const sarah = await fixtureAgent('support');
  const observer = await fixtureAgent('support', false);
  const mayaAlex = await observe(maya.id, 'Alex Chen');
  const mayaPriya = await observe(maya.id, 'Priya Patel');
  const sarahAlex = await observe(
    sarah.id,
    'Private Alex Label',
    'Other agent private conversation marker.',
  );
  const sarahPartner = await observe(sarah.id, 'Morgan Lee');
  const unsafeName = await observe(maya.id, 'Spoofed \u202e display name');
  await sql`insert into person_relationship_notes (agent_id, source_event_id, summary, excerpt)
    values (${sarah.id}, ${sarahAlex.sourceId}, 'Other agent private note marker.', 'private conversation marker')`;
  const [sarahRun] = await sql<{ id: string }[]>`insert into simulation_runs
    (agent_id, configuration_id, origin, input, status, actor, result, expires_at)
    values (${sarah.id}, ${sarah.configurationId}, 'discovery', 'Fixture', 'completed', ${actor},
      '{"steps":[],"actions":[],"error":null}', now()) returning id`;
  await sql`update source_events set run_id = ${sarahRun.id} where id = ${sarahAlex.sourceId}`;
  await sql`insert into agent_memories
    (agent_id, subject_kind, subject, topic, identity_key, fact, quote, run_id, source_kind, source_id, source_at, person_field, person_value)
    values (${sarah.id}, 'person', 'Alex', 'Company', 'private-alex', 'Other agent private memory marker.',
      'private conversation marker', ${sarahRun.id}, 'event', ${sarahAlex.sourceId}, now(), 'company', 'Confidential company')`;

  // A connected identity may share a canonical person without sharing an agent's observations.
  expect(
    await savePersonLink(actor, {
      identity: {
        id: mayaAlex.identityId,
        revision: mayaAlex.revision,
        sourceId: mayaAlex.sourceId,
      },
      target: {
        id: sarahAlex.identityId,
        revision: sarahAlex.revision,
        sourceId: sarahAlex.sourceId,
      },
      reason: 'Synthetic sources identify the same person.',
    }),
  ).toHaveProperty('message');
  const [history, own] = await Promise.all([
    getPersonContextForAgent(sarah.id, sarahAlex.personId),
    getPersonContextForAgent(maya.id, sarahAlex.personId),
  ]);
  expect(JSON.stringify(history)).toContain('Other agent private conversation marker.');
  expect(JSON.stringify(history)).toContain('Other agent private note marker.');
  expect(JSON.stringify(own)).not.toContain('Other agent private');

  const linkedAlex = { ...mayaAlex, personId: sarahAlex.personId };
  const proposal = await propose(maya, linkedAlex, mayaPriya);
  expect(proposal.search).toEqual({
    untrustedResults: expect.arrayContaining([
      { name: 'Alex Chen', personId: sarahAlex.personId },
      { name: 'Priya Patel', personId: mayaPriya.personId },
    ]),
  });
  expect(JSON.stringify([proposal.search, ...proposal.requests])).not.toMatch(
    /Other agent private|Private Alex Label|Confidential company|Morgan Lee|Spoofed/i,
  );
  await propose(maya, linkedAlex, sarahPartner, false);
  await propose(maya, linkedAlex, unsafeName, false);
  await propose(sarah, sarahAlex, sarahPartner);
  await propose(observer, sarahAlex, sarahPartner, false, false);

  const ungrantedRun = randomUUID();
  const token = randomUUID();
  await sql`insert into simulation_runs (id, agent_id, configuration_id, origin, input, status, actor, result, expires_at, execution_token)
    values (${ungrantedRun}, ${observer.id}, ${observer.configurationId}, 'playground', 'Fixture', 'running',
      ${actor}, '{"steps":[],"actions":[],"error":null}', now() + interval '1 minute', ${token})`;
  const policy = await loadPolicyContext(observer.id, actor, ungrantedRun);
  if (!policy) throw new Error('Missing policy context');
  expect(
    await authorizeAction(policy, {
      type: PEOPLE_INTRODUCE,
      executionToken: token,
      idempotencyKey: ungrantedRun,
    }),
  ).toHaveProperty('decision', 'deny');

  expect(await persistPeopleGrant(actor, observer.id, PEOPLE_INTRODUCE, true)).toHaveProperty(
    'message',
  );
  await sql`update simulation_runs set origin = 'replay' where id = ${ungrantedRun}`;
  const replay = await loadPolicyContext(observer.id, actor, ungrantedRun);
  if (!replay) throw new Error('Missing replay context');
  expect(
    await authorizeAction(replay, {
      type: PEOPLE_INTRODUCE,
      executionToken: token,
      idempotencyKey: `${ungrantedRun}:replay`,
    }),
  ).toHaveProperty('decision', 'deny');

  expect(await persistPeopleGrant(actor, observer.id, PEOPLE_SEARCH, true)).toHaveProperty(
    'message',
  );
  expect(
    await authorizeAction(replay, {
      type: PEOPLE_SEARCH,
      readOnly: true,
      executionToken: token,
      idempotencyKey: `${ungrantedRun}:replay-search`,
    }),
  ).toHaveProperty('decision', 'deny');

  if (!proposal.introductionId) throw new Error('Missing Maya proposal');
  expect(await consent(proposal.introductionId, linkedAlex.personId, 'agreed')).toHaveProperty(
    'message',
  );
  expect(await consent(proposal.introductionId, mayaPriya.personId, 'agreed')).toHaveProperty(
    'message',
  );
  const review = await reviewId(proposal.introductionId);
  if (!review) throw new Error('Missing review');
  expect(
    await removePersonLink(actor, {
      identity: {
        id: mayaAlex.identityId,
        revision: mayaAlex.revision + 1,
        sourceId: mayaAlex.sourceId,
      },
      reason: 'The original People binding changed.',
    }),
  ).toHaveProperty('message');
  expect(await reviewProposedAction(actor, maya.id, review, 'approved')).toHaveProperty(
    'error',
    expect.stringMatching(/identity or its source changed/),
  );
});

async function observeEmail(agentId: string, name: string, address: string) {
  const [thread] = await sql`insert into email_threads (agent_id) values (${agentId}) returning id`;
  const [message] = await sql<{ id: string; person_identity_id: string }[]>`
    insert into email_messages (agent_id, resend_email_id, event, sender, subject, received_at, thread_id)
    values (${agentId}, ${randomUUID()}, '{}', ${`${name} <${address}>`}, 'Synthetic prior message', now(), ${thread.id})
    returning id, person_identity_id
  `;
  identities.push(message.person_identity_id);
  const [identity] = await sql<{ person_id: string; revision: number }[]>`
    select person_id, revision from person_identities where id = ${message.person_identity_id}
  `;
  return {
    sourceId: message.id,
    identityId: message.person_identity_id,
    personId: identity.person_id,
    revision: identity.revision,
    address,
  };
}

async function emailFixture(template: 'superconnector' | 'support' = 'superconnector') {
  const agent = await fixtureAgent(template);
  const from = `agent-${agent.id}@orbit.example.test`;
  await sql`insert into email_mailboxes (agent_id, address, enabled) values (${agent.id}, ${from}, true)`;
  await persistChannelGrant(actor, agent.id, EMAIL_INTRODUCTION_ACTION, true);
  const alex = await observeEmail(agent.id, 'Alex Chen', `alex-${agent.id}@example.test`);
  const priya = await observeEmail(agent.id, 'Priya Patel', `priya-${agent.id}@example.test`);
  const { introductionId: id } = await propose(agent, alex, priya, true, true, false);
  if (!id) throw new Error('Missing introduction');
  const proposal = (await db().select().from(introductionProposals)).find((row) => row.id === id);
  if (!proposal) throw new Error('Missing proposal');
  const preview = await introductionEmailDisclosure(db(), proposal);
  if (!preview) throw new Error('Missing email disclosure');
  return { id, agent, from, alex, priya, preview };
}

type EmailFixture = Awaited<ReturnType<typeof emailFixture>>;

async function agreeEmail({ id, alex, priya, preview }: EmailFixture) {
  expect(await consent(id, alex.personId, 'agreed')).toHaveProperty('error');
  expect(await consent(id, alex.personId, 'agreed', preview.digest)).toHaveProperty('message');
  expect(await reviewId(id)).toBeNull();
  expect(await consent(id, priya.personId, 'agreed', preview.digest)).toHaveProperty('message');
  const intentId = await reviewId(id);
  if (!intentId) throw new Error('Missing email introduction approval');
  expect(await reviewIntent(intentId)).toMatchObject({
    actionType: EMAIL_INTRODUCTION_ACTION,
    recipients: [alex.address, priya.address],
    payload: preview,
  });
  return intentId;
}

const workerId = 'introduction-email-fixture';

async function claimIntroductionJob(intentId: string) {
  const job = (await claimJobs({ workerId, types: [CHANNEL_OUTBOUND_JOB], limit: 10 })).find(
    ({ payload }) => payload.intentId === intentId,
  );
  if (!job) throw new Error('Missing outbound job');
  return job;
}

function dispatch(
  job: Awaited<ReturnType<typeof claimIntroductionJob>>,
  transport: EmailTransport,
  domain = 'orbit.example.test',
) {
  return processOutboundJob(job, signal, {
    actionType: EMAIL_INTRODUCTION_ACTION,
    prepareDelivery: (tx, row, intent) =>
      prepareIntroductionDelivery(tx, row, intent, transport, domain),
  });
}

async function unpauseForTest() {
  const [control] = await sql<{ paused: boolean }[]>`select paused from controls where id = 1`;
  await sql`update controls set paused = false where id = 1`;
  return () => sql`update controls set paused = ${control.paused} where id = 1`;
}

test('email approval queues one Maya send to two visible recipients and retry reuses the provider key', async () => {
  const restore = await unpauseForTest();
  try {
    const fixture = await emailFixture();
    const { id, agent, from, alex, priya, preview } = fixture;
    const intentId = await agreeEmail(fixture);
    expect(await reviewProposedAction(actor, agent.id, intentId, 'approved')).toHaveProperty(
      'error',
    );
    await sql`update agents set lifecycle = 'live' where id = ${agent.id}`;
    expect(
      await reviewProposedAction(actor, agent.id, intentId, 'approved', {
        editedPayload: { subject: 'Different subject' },
      }),
    ).toHaveProperty('error');
    const outcomes = await Promise.all([
      reviewProposedAction(actor, agent.id, intentId, 'approved'),
      reviewProposedAction(actor, agent.id, intentId, 'approved'),
    ]);
    expect(outcomes.filter((outcome) => 'message' in outcome)).toHaveLength(1);
    expect(await sql`select id from outbound_actions where intent_id = ${intentId}`).toHaveLength(
      1,
    );
    expect(await sql`select id from jobs where payload->>'intentId' = ${intentId}`).toHaveLength(1);

    // The provider accepted the first request but its response was lost.
    const accepted = new Set<string>();
    const transport = createStubEmailTransport(({ idempotencyKey }) => {
      if (accepted.has(idempotencyKey)) return { ok: true, id: 'resend-fixture', raw: {} };
      accepted.add(idempotencyKey);
      return { ok: false, retryable: true, error: 'Synthetic temporary failure' };
    });
    const job = await claimIntroductionJob(intentId);
    await expect(dispatch(job, transport)).rejects.toThrow('Synthetic temporary failure');
    await failJob(job.id, workerId, 'Synthetic temporary failure');
    await sql`update jobs set available_at = now() where id = ${job.id}`;
    const retry = await claimIntroductionJob(intentId);
    await dispatch(retry, transport);
    await dispatch(retry, transport);
    await completeJob(retry.id, workerId);
    expect(accepted.size).toBe(1);
    expect(transport.calls).toEqual(
      Array(2).fill({
        from,
        to: [alex.address, priya.address],
        subject: preview.subject,
        text: preview.draft,
        headers: {},
        idempotencyKey: `email-introduction:${id}`,
      }),
    );
    const [delivery] =
      await sql`select status, provider, provider_message_id from outbound_actions where intent_id = ${intentId}`;
    expect(delivery).toMatchObject({
      status: 'sent',
      provider: 'resend',
      provider_message_id: 'resend-fixture',
    });
  } finally {
    await restore();
  }
});

test('dispatch blocks revoked or changed disclosure and current policy or sender failures', async () => {
  const restore = await unpauseForTest();
  try {
    const cases: [string, (fixture: EmailFixture, intentId: string) => Promise<unknown>, RegExp][] =
      [
        ['revoked', ({ id, alex }) => consent(id, alex.personId, 'revoked'), /currently agree/],
        [
          'identity',
          ({ alex }) =>
            sql`update person_identities set revision = revision + 1 where id = ${alex.identityId}`,
          /identity/,
        ],
        [
          'address',
          ({ alex }) =>
            sql`update email_messages set sender = 'Alex Chen <changed@example.test>' where id = ${alex.sourceId}`,
          /addresses changed/,
        ],
        [
          'payload',
          (_, intentId) =>
            sql`update action_intents set payload = jsonb_set(payload, '{subject}', '"Changed"') where id = ${intentId}`,
          /draft or addresses changed/,
        ],
        [
          'grant',
          ({ agent }) => persistChannelGrant(actor, agent.id, EMAIL_INTRODUCTION_ACTION, false),
          /not enabled/,
        ],
        [
          'shadow',
          ({ agent }) => sql`update agents set lifecycle = 'shadow' where id = ${agent.id}`,
          /Shadow/,
        ],
        [
          'paused agent',
          ({ agent }) => sql`update agents set lifecycle = 'paused' where id = ${agent.id}`,
          /paused/,
        ],
        [
          'budget',
          ({ agent }) =>
            sql`update agents set budgets = jsonb_set(budgets, '{dailyOutboundActions}', '0') where id = ${agent.id}`,
          /outbound/i,
        ],
        [
          'mailbox',
          ({ agent }) =>
            sql`update email_mailboxes set enabled = false where agent_id = ${agent.id}`,
          /mailbox is disabled/,
        ],
        [
          'sender domain',
          ({ agent }) =>
            sql`update email_mailboxes set address = ${`${agent.id}@wrong.example.test`} where agent_id = ${agent.id}`,
          /sending domain/,
        ],
        [
          'global pause',
          () => sql`update controls set paused = true where id = 1`,
          /Global outbound pause/,
        ],
      ];
    for (const [name, change, reason] of cases) {
      const fixture = await emailFixture('support');
      const { agent } = fixture;
      const intentId = await agreeEmail(fixture);
      await sql`update agents set lifecycle = 'live' where id = ${agent.id}`;
      expect(
        await reviewProposedAction(actor, agent.id, intentId, 'approved'),
        name,
      ).toHaveProperty('message');
      const job = await claimIntroductionJob(intentId);
      await change(fixture, intentId);
      const transport = createStubEmailTransport();
      await dispatch(job, transport);
      await completeJob(job.id, workerId);
      expect(transport.calls, name).toHaveLength(0);
      const [delivery] =
        await sql`select status, reason from outbound_actions where intent_id = ${intentId}`;
      expect(delivery, name).toMatchObject({
        status: 'blocked',
        reason: expect.stringMatching(reason),
      });
      expect((await reviewIntent(intentId)).reviewStatus).toBe('approved');
    }
  } finally {
    await restore();
  }
});

test('a changed address binding cannot reuse the first agreement', async () => {
  const { id, agent, alex, priya, preview } = await emailFixture();
  expect(await consent(id, alex.personId, 'agreed', preview.digest)).toHaveProperty('message');
  // Identity relinking can change the binding even when the visible address stays the same.
  await sql`update person_identities set revision = revision + 1 where id = ${priya.identityId}`;
  expect(await consent(id, priya.personId, 'agreed', preview.digest)).toHaveProperty('error');
  expect(await reviewId(id)).toBeNull();
  const [consents] =
    await sql`select count(*)::int from recipient_consents where introduction_id = ${id} and agent_id = ${agent.id}`;
  expect(consents.count).toBe(1);
});

test.each([
  ['the provider retry window expires', 'failed', /retry window expired/],
  [
    'consent is revoked before retry',
    'blocked',
    /currently agree.*earlier attempt may have reached the provider/,
  ],
])('an uncertain attempt is never sent again when %s', async (_, status, reason) => {
  const restore = await unpauseForTest();
  try {
    const fixture = await emailFixture();
    const intentId = await agreeEmail(fixture);
    await sql`update agents set lifecycle = 'live' where id = ${fixture.agent.id}`;
    expect(
      await reviewProposedAction(actor, fixture.agent.id, intentId, 'approved'),
    ).toHaveProperty('message');
    const job = await claimIntroductionJob(intentId);
    const transport = createStubEmailTransport(() => ({
      ok: false,
      retryable: true,
      error: 'Synthetic timeout',
    }));
    await expect(dispatch(job, transport)).rejects.toThrow('Synthetic timeout');
    await failJob(job.id, workerId, 'Synthetic timeout');
    await sql`update jobs set available_at = now() where id = ${job.id}`;
    if (status === 'blocked') {
      await consent(fixture.id, fixture.alex.personId, 'revoked');
    } else {
      await sql`update outbound_actions set dispatched_at = now() - interval '24 hours' where intent_id = ${intentId}`;
    }
    const retry = await claimIntroductionJob(intentId);
    await dispatch(retry, transport);
    await completeJob(retry.id, workerId);
    expect(transport.calls).toHaveLength(1);
    const [delivery] =
      await sql`select status, reason from outbound_actions where intent_id = ${intentId}`;
    expect(delivery).toMatchObject({
      status,
      reason: expect.stringMatching(reason),
    });
  } finally {
    await restore();
  }
});

test('a linked mailbox observed only by another agent cannot supply a recipient', async () => {
  const maya = await fixtureAgent('superconnector');
  const other = await fixtureAgent('support');
  const alex = await observe(maya.id, 'Alex Chen');
  const priya = await observeEmail(maya.id, 'Priya Patel', `priya-${maya.id}@example.test`);
  const privateEmail = await observeEmail(
    other.id,
    'Alex Chen',
    `private-${other.id}@example.test`,
  );
  expect(
    await savePersonLink(actor, {
      identity: {
        id: privateEmail.identityId,
        revision: privateEmail.revision,
        sourceId: privateEmail.sourceId,
      },
      target: { id: alex.identityId, revision: alex.revision, sourceId: alex.sourceId },
      reason: 'Synthetic cross-channel link.',
    }),
  ).toHaveProperty('message');
  const { introductionId: id } = await propose(maya, alex, priya, true, true, false);
  if (!id) throw new Error('Missing introduction');
  const proposal = (await db().select().from(introductionProposals)).find((row) => row.id === id);
  if (!proposal) throw new Error('Missing proposal');
  expect(await introductionEmailDisclosure(db(), proposal)).toBeNull();
  expect(await consent(id, alex.personId, 'agreed')).toHaveProperty('error');
  expect(await reviewId(id)).toBeNull();
});
