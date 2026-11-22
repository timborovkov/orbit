import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import postgres from 'postgres';

import { budgetDefaults } from '@/lib/budgets';
import { db } from '@/lib/db';
import { recipientConsentFailure } from '@/lib/policy/consent';
import { claimJobs, completeJob } from '@/lib/queue/jobs';
import { processEmailReceiveJob } from '@/lib/runtime/email/receive';
import { EMAIL_RECEIVE_JOB } from '@/lib/runtime/email/settings';
import { processEmailDraftJob, processSimulationJob } from '@/lib/runtime/execute';
import {
  getPersonContextForAgent,
  listPersonInteractions,
  searchRunHistory,
} from '@/lib/runtime/people/history';
import type { ModelCall } from '@/lib/runtime/simulation';
import { createFixtureXSearchAdapter } from '@/lib/runtime/x/fixture';
import { processDiscoveryPoll } from '@/lib/runtime/x/poll';
import { persistReceivedEmail } from '@/lib/server/email-mutations';
import { saveAgentMemory } from '@/lib/server/memory-mutations';
import { selectAgentMemoryEvidence, selectPersonMemories } from '@/lib/server/memory-queries';
import { removePersonLink, savePersonLink } from '@/lib/server/people-mutations';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://orbit:orbit_dev@localhost:5432/orbit_test';
const sql = postgres(databaseUrl);
const admin = 'people-admin@example.test';
const worker = 'people-test-worker';
const signal = new AbortController().signal;
const agentIds: string[] = [];
const identityKeys: string[] = [];
const previousEnv = {
  databaseUrl: process.env.DATABASE_URL,
  openRouterKey: process.env.OPENROUTER_API_KEY,
};

beforeAll(() => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.OPENROUTER_API_KEY = 'fixture-key';
});

afterAll(async () => {
  if (previousEnv.databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousEnv.databaseUrl;
  if (previousEnv.openRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = previousEnv.openRouterKey;
  try {
    for (const id of agentIds) {
      await sql`delete from email_messages where agent_id = ${id}`;
      await sql`delete from source_events where agent_id = ${id}`;
      await sql`delete from usage_counters where agent_id = ${id}`;
      await sql`delete from policy_decisions where agent_id = ${id}`;
      await sql`delete from action_intents where agent_id = ${id}`;
      await sql`delete from simulation_runs where agent_id = ${id}`;
      await sql`delete from jobs where payload->>'agentId' = ${id}`;
      await sql`delete from agent_configurations where agent_id = ${id}`;
      await sql`delete from agents where id = ${id}`;
    }
    const identityRows = await sql<{ id: string; person_id: string; home_person_id: string }[]>`
      select id, person_id, home_person_id from person_identities where identity_key in ${sql(identityKeys)}
    `;
    if (identityRows.length) {
      const ids = identityRows.map(({ id }) => id);
      const people = [
        ...new Set(
          identityRows.flatMap(({ person_id, home_person_id }) => [person_id, home_person_id]),
        ),
      ];
      await sql`delete from person_link_rejections where first_identity_id in ${sql(ids)} or second_identity_id in ${sql(ids)}`;
      await sql`delete from person_identity_changes where identity_id in ${sql(ids)}`;
      await sql`delete from person_identities where id in ${sql(ids)}`;
      await sql`delete from people where id in ${sql(people)}`;
    }
  } finally {
    await sql.end();
  }
});

async function agent(name: string) {
  const id = randomUUID();
  agentIds.push(id);
  const address = `${id}@inbound.example.test`;
  const budgets = { ...budgetDefaults, dailySpendCents: null, monthlySpendCents: null };
  await sql`insert into agents (id, name, mission, budgets) values (${id}, ${name}, 'Help customers', ${sql.json(budgets)})`;
  await sql`insert into agent_configurations (agent_id, version, config, actor)
    select ${id}, 1, config || jsonb_build_object('name', ${name}::text, 'xSearchQuery', '*'), ${admin} from templates where id = 'support'`;
  await sql`insert into email_mailboxes (agent_id, address, enabled) values (${id}, ${address}, true)`;
  return { id, address };
}

function delivery(to: string, sender: string, subject: string) {
  return {
    type: 'email.received' as const,
    data: {
      email_id: randomUUID(),
      created_at: new Date().toISOString(),
      to: [to],
      from: sender,
      subject,
    },
  };
}

async function receive(agentId: string, resendId: string, body: string) {
  const [job] = (
    await claimJobs({ workerId: worker, types: [EMAIL_RECEIVE_JOB], limit: 100 })
  ).filter(({ payload }) => payload.agentId === agentId);
  expect(job).toBeDefined();
  await processEmailReceiveJob(job, worker, signal, (id) => {
    expect(id).toBe(resendId);
    return Promise.resolve({ body, messageId: null, inReplyTo: [], referenceIds: [] });
  });
  await completeJob(job.id, worker);
  const [source] = await sql<
    { id: string; run_id: string; thread_id: string; person_identity_id: string }[]
  >`
    select id, run_id, thread_id, person_identity_id from email_messages
    where agent_id = ${agentId} and resend_email_id = ${resendId}
  `;
  return source;
}

async function observe(
  agentId: string,
  id: string,
  authorId: string,
  handle: string,
  text: string,
  evaluate = false,
) {
  const adapter = createFixtureXSearchAdapter([
    {
      id,
      authorId,
      authorUsername: handle,
      text,
      raw: { id },
      createdAt: new Date().toISOString(),
    },
  ]);
  return processDiscoveryPoll({ payload: { agentId } }, signal, { adapter, evaluate });
}

function inference(summary: string, excerpt: string) {
  return () => async (request: { summarizeRelationship?: boolean }) => ({
    decision: { relevant: false, priority: 0, reason: 'No response needed', actions: [] },
    relationshipNote: request.summarizeRelationship ? { summary, excerpt } : null,
    inputTokens: 10,
    outputTokens: 5,
    costMicros: 0,
  });
}

async function identityFor(channel: string, key: string) {
  const [row] = await sql<
    { id: string; person_id: string; revision: number; link_state: string }[]
  >`
    select id, person_id, revision, link_state from person_identities where channel = ${channel} and identity_key = ${key}
  `;
  expect(row).toBeDefined();
  return row;
}

test('person facts follow current evidence identities and stay private to the learning agent', async () => {
  const sarah = await agent('Sarah');
  const john = await agent('John');
  const author = `x-${randomUUID()}`;
  const sender = `riley-${randomUUID()}@example.test`;
  identityKeys.push(sender, author);
  const libraryId = randomUUID();
  await sql`INSERT INTO knowledge_libraries (id, name) VALUES (${libraryId}, 'Shared company resources')`;
  try {
    await sql`INSERT INTO knowledge_library_grants (library_id, agent_id)
      VALUES (${libraryId}, ${sarah.id}), (${libraryId}, ${john.id})`;
    const inbound = delivery(sarah.address, `Riley <${sender}>`, 'Nice to meet you');
    await persistReceivedEmail(inbound);
    const quote = 'I work at Acme as a Staff Engineer.';
    const thirdParty = 'Jordan works at Other Co.';
    const email = await receive(sarah.id, inbound.data.email_id, `${thirdParty} ${quote}`);
    const model = async (request: Parameters<ModelCall>[0]) => {
      expect(request.system).toContain('For the current author only');
      return {
        ...(await inference('', '')()(request)),
        memoryCandidates: [
          {
            subjectKind: 'person',
            personFact: { field: 'company', value: 'Other Co' },
            quote: thirdParty,
          },
          { subjectKind: 'person', personFact: { field: 'company', value: 'Acme' }, quote },
          {
            subjectKind: 'person',
            personFact: { field: 'job_title', value: 'Staff Engineer' },
            quote,
          },
        ],
      };
    };
    const draft = () => processEmailDraftJob({ runId: email.run_id }, () => model);
    await draft();
    await draft();
    const memories = await sql<
      { id: string; revision: string; person_field: string; person_value: string; fact: string }[]
    >`
      SELECT id, revision, person_field, person_value, fact FROM agent_memories
      WHERE agent_id = ${sarah.id} ORDER BY person_field`;
    expect(
      memories.map(({ person_field, person_value, fact }) => [person_field, person_value, fact]),
    ).toEqual([
      ['company', 'Acme', 'Riley works at Acme.'],
      ['job_title', 'Staff Engineer', 'Riley’s job title is Staff Engineer.'],
    ]);
    const [company] = memories;
    expect(await selectAgentMemoryEvidence(sarah.id, company.id, company.revision)).toMatchObject({
      quote,
      source: { id: email.id, href: expect.stringContaining(`emailMessage=${email.id}`) },
    });
    expect(await selectAgentMemoryEvidence(john.id, company.id, company.revision)).toBeNull();

    const repeated = delivery(sarah.address, `Riley <${sender}>`, 'Another introduction');
    await persistReceivedEmail(repeated);
    const repeatedEmail = await receive(sarah.id, repeated.data.email_id, quote);
    await processEmailDraftJob({ runId: repeatedEmail.run_id }, () => async (request) => ({
      ...(await inference('', '')()(request)),
      memoryCandidates: [
        {
          subjectKind: 'company',
          subject: 'Acme',
          topic: 'Staff',
          fact: 'Riley works at Acme.',
          quote,
        },
        {
          subjectKind: 'note',
          subject: 'Acme',
          topic: 'Staff',
          note: { kind: 'observation', text: 'Riley works at Acme.' },
          quote,
        },
        {
          subjectKind: 'note',
          subject: 'Acme',
          topic: 'Invalid shape',
          note: { kind: 'observation', text: quote, permissions: 'owner' },
          quote,
        },
      ],
    }));
    const aliases = await sql`SELECT subject_kind, note FROM agent_memories
      WHERE agent_id = ${sarah.id} AND subject_kind <> 'person' ORDER BY subject_kind`;
    expect([...aliases]).toEqual([
      { subject_kind: 'company', note: null },
      { subject_kind: 'note', note: { kind: 'observation', text: 'Riley works at Acme.' } },
    ]);

    const runX = async (agentId: string, eventId: string, text: string) => {
      expect((await observe(agentId, eventId, author, 'riley', text, true)).evaluated).toBe(1);
      const [post] = await sql<{ id: string; run_id: string }[]>`
        SELECT id, run_id FROM source_events WHERE agent_id = ${agentId} AND provider_event_id = ${eventId}`;
      const inputs: { untrustedMemories?: unknown[] }[] = [];
      await processSimulationJob({ runId: post.run_id }, () => async (request) => {
        inputs.push(JSON.parse(request.input));
        return inference('', '')()(request);
      });
      expect(inputs).toHaveLength(1);
      return { id: post.id, memories: inputs[0]?.untrustedMemories };
    };
    const observed = await runX(sarah.id, '201', 'Riley works at Acme as a Staff Engineer?');
    expect(observed.memories).toBeUndefined();
    const x = await identityFor('x', author);
    const mail = await identityFor('email', sender);
    const identity = { id: x.id, revision: x.revision, sourceId: observed.id };
    expect(
      await savePersonLink(admin, {
        identity,
        target: { id: mail.id, revision: mail.revision, sourceId: email.id },
        reason: 'Confirmed Riley owns this X account.',
      }),
    ).toEqual({ message: 'Identity linked.' });

    expect((await runX(sarah.id, '202', 'Hello again.')).memories).toMatchObject([
      {
        subjectKind: 'person',
        fact: 'Riley works at Acme.',
        personFact: { field: 'company', value: 'Acme' },
      },
      { subjectKind: 'person', personFact: { field: 'job_title', value: 'Staff Engineer' } },
    ]);
    expect((await runX(sarah.id, '203', 'Riley works at Acme?')).memories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subjectKind: 'company', fact: 'Riley works at Acme.' }),
        expect.objectContaining({
          subjectKind: 'note',
          note: { kind: 'observation', text: 'Riley works at Acme.' },
        }),
      ]),
    );
    expect((await runX(john.id, '202', 'Riley works at Acme.')).memories).toBeUndefined();
    expect(await selectPersonMemories(sarah.id, mail.person_id)).toHaveLength(2);
    expect(await selectPersonMemories(john.id, mail.person_id)).toHaveLength(0);

    const edit = { agentId: sarah.id, id: company.id, revision: company.revision };
    expect(
      await saveAgentMemory(admin, edit, { fact: 'Free text', expiresOn: null, reviewOn: null }),
    ).toHaveProperty('error');
    expect(
      await saveAgentMemory(admin, edit, {
        personValue: 'Acme Labs',
        expiresOn: null,
        reviewOn: null,
      }),
    ).toHaveProperty('message');
    expect((await runX(sarah.id, '204', 'A follow-up.')).memories).toMatchObject([
      { fact: 'Riley works at Acme Labs.', personFact: { value: 'Acme Labs' } },
      { topic: 'Job title' },
    ]);

    const linked = await identityFor('x', author);
    expect(
      await removePersonLink(admin, {
        identity: { ...identity, revision: linked.revision },
        reason: 'This is a different Riley.',
      }),
    ).toEqual({ message: 'Identity unlinked.' });
    expect(
      (await runX(sarah.id, '205', 'Riley works at Acme Labs as a Staff Engineer?')).memories,
    ).toBeUndefined();
    expect(await selectPersonMemories(sarah.id, x.person_id)).toHaveLength(0);
    const own = await selectPersonMemories(sarah.id, mail.person_id);
    const corrected = own.find(({ id }) => id === company.id)!;
    expect(corrected.value).toBe('Acme Labs');
    expect(await selectAgentMemoryEvidence(sarah.id, company.id, corrected.revision)).toMatchObject(
      { quote, source: { id: email.id } },
    );

    expect(
      await saveAgentMemory(
        admin,
        { ...edit, revision: corrected.revision },
        {
          personValue: 'Acme Labs',
          expiresOn: '2000-01-01',
          reviewOn: null,
        },
      ),
    ).toHaveProperty('message');
    expect(
      (await selectPersonMemories(sarah.id, mail.person_id)).map(({ topic }) => topic),
    ).toEqual(['Job title']);
    const followUp = delivery(sarah.address, `Riley <${sender}>`, 'Follow-up');
    await persistReceivedEmail(followUp);
    const laterEmail = await receive(sarah.id, followUp.data.email_id, 'Checking in again.');
    await processEmailDraftJob({ runId: laterEmail.run_id }, () => async (request) => {
      expect(JSON.parse(request.input).untrustedMemories).toMatchObject([
        { topic: 'Job title', personFact: { value: 'Staff Engineer' } },
      ]);
      expect(request.input).not.toContain('Acme Labs');
      return inference('', '')()(request);
    });
    const [finished] = await sql`SELECT status FROM simulation_runs WHERE id=${laterEmail.run_id}`;
    expect(finished?.status).toBe('completed');
  } finally {
    await sql`DELETE FROM knowledge_libraries WHERE id = ${libraryId}`;
  }
});

test('known identities deduplicate repeated activity and keep private context isolated through admin link and unlink', async () => {
  const suffix = randomUUID();
  const sender = `riley-${suffix}@example.test`;
  const author = `x-${suffix}`;
  identityKeys.push(sender, author);
  const first = await agent('People support');
  const second = await agent('People research');
  const firstDelivery = delivery(
    first.address,
    `"Riley" <${sender.toUpperCase()}>`,
    'Support interaction',
  );
  await Promise.all([persistReceivedEmail(firstDelivery), persistReceivedEmail(firstDelivery)]);
  const emailA = await receive(first.id, firstDelivery.data.email_id, 'I need a paper invoice.');
  const secondDelivery = delivery(second.address, sender, 'Research conversation');
  await persistReceivedEmail(secondDelivery);
  const emailB = await receive(
    second.id,
    secondDelivery.data.email_id,
    'I prefer a Friday demonstration.',
  );
  expect(emailA.person_identity_id).toBe(emailB.person_identity_id);
  const email = await identityFor('email', sender);
  await processEmailDraftJob(
    { runId: emailA.run_id },
    inference('Needs a paper invoice.', 'I need a paper invoice.'),
  );
  await processEmailDraftJob(
    { runId: emailB.run_id },
    inference('Prefers Fridays.', 'I prefer a Friday demonstration.'),
  );

  const [xA, xB] = await Promise.all([
    observe(first.id, '100', author, 'riley_first', 'I prefer text updates.', true),
    observe(second.id, '100', author, 'riley_first', 'I prefer text updates.'),
  ]);
  expect(xA.inserted + xB.inserted).toBe(2);
  const x = await identityFor('x', author);
  const [post] = await sql<
    { id: string; run_id: string }[]
  >`select id, run_id from source_events where agent_id = ${first.id} and provider_event_id = '100'`;
  await processSimulationJob(
    { runId: post.run_id },
    inference('Reject this unsupported note.', 'This phrase does not appear in the post.'),
  );
  expect((await getPersonContextForAgent(first.id, x.person_id)).notes).toHaveLength(0);

  await sql`insert into recipient_consents (agent_id, recipient, scope, evidence, granted, actor)
    values (${first.id}, ${sender}, 'escalate', 'Recipient refusal fixture', false, ${admin})`;
  const linkInput = {
    identity: { id: x.id, revision: x.revision, sourceId: post.id },
    target: { id: email.id, revision: email.revision, sourceId: emailA.id },
    reason: 'The sources show the same contact.',
  };
  expect(await savePersonLink(admin, linkInput)).toEqual({ message: 'Identity linked.' });
  expect(await savePersonLink(admin, linkInput)).toHaveProperty('error');
  expect((await identityFor('x', author)).person_id).toBe(email.person_id);
  expect(
    (await observe(first.id, '100', author, 'riley_first', 'I prefer text updates.')).inserted,
  ).toBe(0);
  await observe(first.id, '101', author, 'riley_renamed', 'A new X interaction.', true);
  const [laterPost] = await sql<{ run_id: string }[]>`
    select run_id from source_events where agent_id = ${first.id} and provider_event_id = '101'
  `;
  const xRequests: Parameters<ModelCall>[0][] = [];
  await processSimulationJob({ runId: laterPost.run_id }, () => async (request) => {
    xRequests.push(request);
    const result = await inference('A private X relationship note.', 'A new X interaction.')()(
      request,
    );
    if (request.stage === 'main') return result;
    return {
      ...result,
      decision: {
        relevant: true,
        priority: 1,
        reason: 'Needs a paper invoice.',
        actions: [{ type: 'reply', reason: 'Needs a paper invoice.', draft: 'Private draft' }],
      },
    };
  });
  expect(xRequests.map(({ stage }) => stage)).toEqual(['evaluator', 'main']);
  const xContext = JSON.stringify(JSON.parse(xRequests[0].input).untrustedRelationshipContext);
  expect(xContext).toContain('Support interaction');
  expect(xContext).toContain('Needs a paper invoice.');
  expect(xContext).not.toContain('A new X interaction.');
  expect(xContext).not.toContain('Research conversation');
  expect(xContext).not.toContain('Prefers Fridays.');
  expect(xRequests[1].input).not.toContain('untrustedRelationshipContext');
  expect(xRequests[1].system).not.toContain('Needs a paper invoice.');

  const laterDelivery = delivery(second.address, sender, 'Later email');
  await persistReceivedEmail(laterDelivery);
  const laterEmail = await receive(second.id, laterDelivery.data.email_id, 'Checking in.');
  const emailRequests: Parameters<ModelCall>[0][] = [];
  await processEmailDraftJob({ runId: laterEmail.run_id }, () => async (request) => {
    emailRequests.push(request);
    return inference('Ignore this unsupported note.', 'Unsupported excerpt.')()(request);
  });
  expect(emailRequests).toHaveLength(1);
  const emailContext = JSON.stringify(
    JSON.parse(emailRequests[0].input).untrustedRelationshipContext,
  );
  expect(emailContext).toContain('I prefer text updates.');
  expect(emailContext).toContain('Research conversation');
  expect(emailContext).toContain('Prefers Fridays.');
  expect(emailContext).not.toContain('A new X interaction.');
  expect(emailContext).not.toContain('Support interaction');
  expect(emailContext).not.toContain('Needs a paper invoice.');

  const workspace = await listPersonInteractions(email.person_id, 1);
  const sharedPost = workspace.interactions.filter(
    ({ title }) => title === 'I prefer text updates.',
  );
  expect(sharedPost).toHaveLength(1);
  expect(sharedPost[0].sources.map(({ agentId }) => agentId).sort()).toEqual(
    [first.id, second.id].sort(),
  );
  expect(workspace.interactions.map(({ title }) => title)).toContain('A new X interaction.');
  expect(workspace.interactions.map(({ title }) => title)).toContain('Later email');
  const own = await getPersonContextForAgent(first.id, email.person_id);
  const other = await getPersonContextForAgent(second.id, email.person_id);
  expect(own.notes.map(({ summary }) => summary)).toEqual([
    'A private X relationship note.',
    'Needs a paper invoice.',
  ]);
  expect(other.notes.map(({ summary }) => summary)).toEqual(['Prefers Fridays.']);
  expect(own.interactions.map(({ title }) => title)).not.toContain('Research conversation');
  expect(other.interactions.map(({ title }) => title)).not.toContain('Support interaction');
  const runs =
    await sql`select result from simulation_runs where id in (${emailA.run_id}, ${laterPost.run_id})`;
  expect(JSON.stringify(runs)).not.toContain('Needs a paper invoice.');
  expect(JSON.stringify(runs)).not.toContain('Private draft');

  const linked = await identityFor('x', author);
  expect(
    await removePersonLink(admin, {
      identity: { ...linkInput.identity, revision: linked.revision },
      reason: 'Wrong account.',
    }),
  ).toEqual({ message: 'Identity unlinked.' });
  expect(
    (await listPersonInteractions(email.person_id, 1)).interactions.every(
      ({ kind }) => kind === 'email',
    ),
  ).toBe(true);
  expect((await listPersonInteractions(x.person_id, 1)).interactions).toHaveLength(2);
  expect(
    (await getPersonContextForAgent(first.id, x.person_id)).notes.map(({ summary }) => summary),
  ).toEqual(['A private X relationship note.']);
  expect((await getPersonContextForAgent(second.id, x.person_id)).notes).toHaveLength(0);
  expect(
    (await getPersonContextForAgent(second.id, email.person_id)).notes.map(
      ({ summary }) => summary,
    ),
  ).toEqual(['Prefers Fridays.']);
  await observe(first.id, '102', author, 'riley_renamed', 'Post after unlink.', true);
  const [postAfterUnlink] = await sql<{ run_id: string }[]>`
    select run_id from source_events where agent_id = ${first.id} and provider_event_id = '102'
  `;
  const unlinkedRequests: Parameters<ModelCall>[0][] = [];
  await processSimulationJob({ runId: postAfterUnlink.run_id }, () => async (request) => {
    unlinkedRequests.push(request);
    return inference('Ignore this unsupported note.', 'Unsupported excerpt.')()(request);
  });
  expect(unlinkedRequests).toHaveLength(1);
  expect(unlinkedRequests[0].input).toContain('A private X relationship note.');
  expect(unlinkedRequests[0].input).not.toContain('Needs a paper invoice.');
  expect(
    await db().transaction((tx) =>
      recipientConsentFailure(tx, first.id, 'escalate', [sender], ['escalate']),
    ),
  ).toBe('A recipient declined or revoked consent for this action.');
  const [preserved] = await sql`select thread_id from email_messages where id = ${emailA.id}`;
  expect(preserved.thread_id).toBe(emailA.thread_id);
});

test('reciprocal claims reconcile automatically, roll back on conflict and respect admin unlink', async () => {
  const suffix = randomUUID();
  const sender = `match-${suffix}@example.test`;
  const author = `match-${suffix}`;
  const differentAuthor = `match-other-${suffix}`;
  identityKeys.push(sender, author, differentAuthor);
  const owner = await agent('Reconciliation fixture');
  const deliver = async (body: string) => {
    const event = delivery(owner.address, sender, 'Identity evidence');
    await persistReceivedEmail(event);
    return receive(owner.id, event.data.email_id, body);
  };

  const message = await deliver('Hello Orbit.\nMy X account: @match_riley');
  const email = await identityFor('email', sender);
  await observe(owner.id, '100', author, 'match_riley', 'I need reporting.');
  const x = await identityFor('x', author);
  expect(x.person_id).not.toBe(email.person_id);

  await observe(owner.id, '101', author, 'match_riley', `My email: ${sender}`);
  let current = await identityFor('x', author);
  expect(current).toMatchObject({ person_id: email.person_id, link_state: 'inferred' });
  await observe(owner.id, '102', author, 'renamed_riley', `My email is ${sender}.`);
  expect(await identityFor('x', author)).toMatchObject({
    person_id: email.person_id,
    link_state: 'inferred',
  });
  await observe(owner.id, '103', author, 'renamed_riley', 'My email: changed@example.test');
  expect(await identityFor('x', author)).toMatchObject({
    person_id: x.person_id,
    link_state: 'standalone',
  });
  await observe(owner.id, '104', author, 'match_riley', `My email: ${sender}`);
  expect((await identityFor('x', author)).link_state).toBe('inferred');

  await observe(
    owner.id,
    '105',
    differentAuthor,
    'match_riley',
    'A different account used this handle.',
  );
  expect((await identityFor('x', author)).link_state).toBe('standalone');
  await deliver('Find me on X at @renamed_riley.');
  await observe(owner.id, '106', author, 'renamed_riley', `My email: ${sender}`);
  current = await identityFor('x', author);
  expect(current.link_state).toBe('inferred');

  const [post] = await sql<
    { id: string }[]
  >`select id from source_events where agent_id = ${owner.id} and provider_event_id = '106'`;
  const linkedIdentity = { id: current.id, revision: current.revision, sourceId: post.id };
  expect(
    await removePersonLink(admin, { identity: linkedIdentity, reason: 'Claims were misleading.' }),
  ).toEqual({ message: 'Identity unlinked.' });
  await observe(owner.id, '107', author, 'renamed_riley', `My email: ${sender}`);
  current = await identityFor('x', author);
  expect(current).toMatchObject({ person_id: x.person_id, link_state: 'standalone' });

  expect(
    await savePersonLink(admin, {
      identity: { id: current.id, revision: current.revision, sourceId: post.id },
      target: { id: email.id, revision: email.revision, sourceId: message.id },
      reason: 'Reviewed with the contact.',
    }),
  ).toEqual({ message: 'Identity linked.' });
  await observe(owner.id, '108', author, 'renamed_riley', 'My email: changed@example.test');
  expect(await identityFor('x', author)).toMatchObject({
    person_id: email.person_id,
    link_state: 'confirmed',
  });
  const changes =
    await sql`select action, evidence from person_identity_changes where identity_id = ${x.id}`;
  expect(changes.map(({ action }) => action)).toEqual(
    expect.arrayContaining(['infer', 'rollback', 'unlink', 'confirm']),
  );
  expect(changes.every(({ evidence }) => evidence.length > 0)).toBe(true);
});

test('history returns text around a late match and keeps normalized channel threads separate', async () => {
  const owner = await agent('History excerpts');
  const author = randomUUID();
  identityKeys.push(author);
  const previous = randomUUID();
  const other = randomUUID();
  const current = randomUUID();
  const channel = 'fixture-chat';
  const milestone = 'The Cobalt milestone is Friday.';
  const body = `${'Unrelated background. '.repeat(48)}${milestone}`;
  for (const id of [previous, other, current]) {
    await sql`INSERT INTO simulation_runs (id, agent_id, configuration_id, input, origin, channel, actor, result, expires_at)
      SELECT ${id}, agent_id, id, 'Synthetic test event', 'channel', ${channel}, ${admin}, '{}', now()
      FROM agent_configurations WHERE agent_id=${owner.id}`;
  }
  await sql`INSERT INTO source_events (agent_id, provider, provider_event_id, account_id, thread_id, payload, text, author_id, run_id, ingested_at)
    VALUES
      (${owner.id}, ${channel}, 'before', 'account', 'pilot', '{}', ${body}, ${author}, ${previous}, now() - interval '2 hours'),
      (${owner.id}, ${channel}, 'other', 'account', 'billing', '{}', 'Cobalt billing question', ${author}, ${other}, now() - interval '1 hour'),
      (${owner.id}, ${channel}, 'current', 'account', 'pilot', '{}', 'When is the milestone?', ${author}, ${current}, now())`;

  const matches = await searchRunHistory(owner.id, current, 'Cobalt', 4);
  expect(matches).toHaveLength(1);
  expect(matches[0]!.excerpt).toContain('The Cobalt milestone is Friday');
  expect(matches[0]!.excerpt.length).toBeLessThanOrEqual(400);
  expect(matches[0]!.excerpt).not.toMatch(/[\u0001\u0002]/u);
  expect((await searchRunHistory(owner.id, current, '', 4))[0]!.excerpt).toBe(body.slice(0, 400));
});
