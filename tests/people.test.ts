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
import { getPersonContextForAgent, listPersonInteractions } from '@/lib/runtime/people/history';
import type { ModelCall } from '@/lib/runtime/simulation';
import { createFixtureXSearchAdapter } from '@/lib/runtime/x/fixture';
import { processDiscoveryPoll } from '@/lib/runtime/x/poll';
import { persistReceivedEmail } from '@/lib/server/email-mutations';
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
