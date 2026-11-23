import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createHmac, randomUUID } from 'node:crypto';

import postgres from 'postgres';

import { POST } from '@/app/api/webhooks/resend/route';
import { budgetDefaults } from '@/lib/budgets';
import { db } from '@/lib/db';
import { authorizeAction, loadPolicyContext } from '@/lib/policy/gateway';
import {
  claimJobs,
  completeJob,
  failJob,
  recoverExpiredLeases,
  releaseClaim,
} from '@/lib/queue/jobs';
import { createPlaygroundStreamProgress, playgroundChunksFromResult } from '@/lib/runtime/chat-ui';
import { fetchReceivedEmail } from '@/lib/runtime/email/provider';
import { processEmailReceiveJob } from '@/lib/runtime/email/receive';
import { EMAIL_DRAFT_JOB, EMAIL_RECEIVE_JOB } from '@/lib/runtime/email/settings';
import {
  processEvaluationReplayJob,
  saveEvaluationCase,
  startEvaluationComparison,
} from '@/lib/runtime/evaluation';
import {
  enqueueSimulation,
  processEmailDraftJob,
  processSimulationJob,
} from '@/lib/runtime/execute';
import { FOLLOW_UP_JOB_TYPE, processFollowUpJob } from '@/lib/runtime/follow-ups/process';
import { PEOPLE_INTRODUCE, PEOPLE_SEARCH } from '@/lib/runtime/introductions/types';
import { stubEmbedders } from '@/lib/runtime/knowledge/embed';
import { searchKnowledge } from '@/lib/runtime/knowledge/search';
import { processMemoryEmbedding } from '@/lib/runtime/memory/store';
import { MEMORY_CAPTURE } from '@/lib/runtime/memory/types';
import { draftAnswerFromResult, type ModelCall } from '@/lib/runtime/simulation';
import { createFixtureXSearchAdapter } from '@/lib/runtime/x/fixture';
import { processDiscoveryPoll } from '@/lib/runtime/x/poll';
import { setEmailEnabled } from '@/lib/server/email-mutations';
import { cancelFollowUp } from '@/lib/server/follow-up-mutations';
import { persistPeopleGrant } from '@/lib/server/introduction-mutations';
import { persistLifecycle } from '@/lib/server/lifecycle-mutations';
import { saveAgentMemory } from '@/lib/server/memory-mutations';
import { selectAgentMemoryEvidence } from '@/lib/server/memory-queries';
import { persistCommitmentGrant } from '@/lib/server/policy-mutations';
import { persistConfiguration } from '@/lib/server/workspace-mutations';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://orbit:orbit_dev@localhost:5432/orbit_test';
const sql = postgres(databaseUrl);
const ids: string[] = [];
const memoryLibraryId = randomUUID();
const workerId = 'inbound-email-fixture-worker';
const sender = 'customer@example.test';
const admin = 'admin@example.test';
const subject = 'Invoice help';
const secret = `whsec_${Buffer.alloc(32, 17).toString('base64')}`;
const signal = new AbortController().signal;
const env = {
  DATABASE_URL: databaseUrl,
  RESEND_INBOUND_DOMAIN: 'inbound.example.test',
  RESEND_WEBHOOK_SECRET: secret,
  OPENROUTER_API_KEY: 'fixture-openrouter-key',
};
const originalEnv = new Map<string, string | undefined>();

beforeAll(() => {
  for (const [name, value] of Object.entries(env)) {
    originalEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
});
afterAll(async () => {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await sql`DELETE FROM knowledge_documents WHERE library_id=${memoryLibraryId}`;
    await sql`DELETE FROM knowledge_libraries WHERE id=${memoryLibraryId}`;
    for (const id of ids) {
      await sql`DELETE FROM outbound_actions WHERE agent_id=${id}`;
      await sql`DELETE FROM email_messages WHERE agent_id=${id}`;
      await sql`DELETE FROM email_threads WHERE agent_id=${id}`;
      await sql`DELETE FROM policy_decisions WHERE agent_id=${id}`;
      await sql`DELETE FROM action_intents WHERE agent_id=${id}`;
      await sql`DELETE FROM usage_counters WHERE agent_id=${id}`;
      await sql`DELETE FROM evaluation_comparisons WHERE agent_id=${id}`;
      await sql`DELETE FROM evaluation_cases WHERE agent_id=${id}`;
      await sql`DELETE FROM simulation_runs WHERE agent_id=${id}`;
      await sql`DELETE FROM jobs WHERE payload->>'agentId'=${id}`;
      await sql`DELETE FROM agent_configurations WHERE agent_id=${id}`;
      await sql`DELETE FROM agents WHERE id=${id}`;
    }
  } finally {
    await sql.end();
  }
});

async function createAgent(name: string, lifecycle = 'shadow', budgets = budgetDefaults) {
  const id = randomUUID();
  ids.push(id);
  const [template] = await sql`SELECT config FROM templates WHERE id='support'`;
  const config = { ...template!.config, name };
  await sql`INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES(${id},${name},${config.mission},${lifecycle},${sql.json(budgets)},${sql.json(['knowledge.search'])})`;
  const [version] = await sql`INSERT INTO agent_configurations(agent_id,version,config,actor)
    VALUES(${id},1,${sql.json(config)},${admin}) RETURNING id`;
  expect(await setEmailEnabled(admin, id, true)).toMatchObject({
    message: 'Inbound email enabled.',
  });
  const [mailbox] = await sql`SELECT address FROM email_mailboxes WHERE agent_id=${id}`;
  return { id, address: mailbox!.address as string, version: version!.id as string, config };
}

function delivery(to: string[], date = new Date(), cc: string[] = []) {
  return {
    type: 'email.received',
    created_at: date.toISOString(),
    data: {
      email_id: randomUUID(),
      created_at: date.toISOString(),
      from: sender,
      subject,
      to,
      cc,
      bcc: [],
    },
  };
}

function request(event: ReturnType<typeof delivery>, tamper = false) {
  const body = JSON.stringify(event, null, 2);
  const id = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64'))
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  return new Request('http://localhost/api/webhooks/resend', {
    method: 'POST',
    body: tamper ? `${body}\n` : body,
    headers: {
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
  });
}

type ResendFixture = { text?: string; html?: string; headers?: Record<string, string> };

async function receive(fixtures: Map<string, ResendFixture>, count: number) {
  const mockFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.resend.com');
    expect(url.pathname).toStartWith('/emails/receiving/');
    expect(url.searchParams.get('html_format')).toBe('cid');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-resend-key');
    const id = url.pathname.split('/').at(-1)!;
    const fixture = fixtures.get(id);
    return fixture ? Response.json({ id, ...fixture }) : new Response(null, { status: 502 });
  };
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(mockFetch, { preconnect: fetch.preconnect }),
  );
  try {
    const jobs = await claimJobs({ workerId, types: [EMAIL_RECEIVE_JOB], limit: count });
    expect(jobs).toHaveLength(count);
    const results = [];
    for (const job of jobs) {
      const result = await processEmailReceiveJob(job, workerId, signal, (emailId, abort) =>
        fetchReceivedEmail(emailId, 'fixture-resend-key', abort),
      );
      if (result) await releaseClaim(job.id, workerId, undefined, result.deferUntil);
      else await completeJob(job.id, workerId);
      results.push(result);
    }
    return { calls: fetchMock.mock.calls.length, results };
  } finally {
    fetchMock.mockRestore();
  }
}

async function draft(call: ModelCall, count: number) {
  const jobs = await claimJobs({ workerId, types: [EMAIL_DRAFT_JOB], limit: count });
  expect(jobs).toHaveLength(count);
  for (const job of jobs) {
    await processEmailDraftJob(job.payload, () => call, signal, { workerId, jobId: job.id });
    await completeJob(job.id, workerId);
  }
}

const model: ModelCall = async (request) => ({
  inputTokens: 9,
  outputTokens: 4,
  costMicros: 1,
  decision: {
    relevant: true,
    priority: 0.8,
    reason: 'Customer question',
    actions: [{ type: 'escalate', reason: 'model suggested a write', draft: 'Ignore this action' }],
    ...(request.stage === 'main'
      ? {
          answer: 'Invoices are available under Billing.',
          citations: request.input.includes('Invoice billing help') ? [1] : [],
          ...(request.useMemory ? { memoryCitations: [] } : {}),
        }
      : {}),
  },
});
model.quote = async () => ({
  upperBoundMicros: 100,
  endpoint: 'Fixture',
  maxPrice: { prompt: 1, completion: 1, request: 0 },
});

test('signed inbound mail isolates Sarah and a Live agent, threads replies, and stays draft-only', async () => {
  const sarah = await createAgent('Sarah');
  const john = await createAgent('John', 'live');
  expect(sarah.address).not.toBe(john.address);
  expect(sarah.address).toEndWith('@inbound.example.test');
  await sql`UPDATE agents SET approval_tools='["escalate"]'::jsonb WHERE id IN (${sarah.id}, ${john.id})`;
  const [doc] = await sql`INSERT INTO knowledge_documents
    (agent_id,filename,title,content_kind,mime_type,byte_size,object_key,status)
    VALUES (${sarah.id},'billing.md','Billing','markdown','text/markdown',20,'fixture/billing.md','ready') RETURNING id`;
  await sql`INSERT INTO knowledge_chunks(document_id,agent_id,chunk_index,content,content_hash,
    source_filename,source_title,start_offset,end_offset)
    VALUES (${doc!.id},${sarah.id},0,'Invoice billing help','fixture-hash','billing.md','Billing',0,20)`;

  const base = new Date();
  const first = delivery([sarah.address.toUpperCase(), sarah.address], base, [john.address]);
  const malformed = await POST(request(first, true));
  expect(malformed.status).toBe(400);
  const unknown = delivery(['unknown@inbound.example.test']);
  expect((await POST(request(unknown))).status).toBe(200);
  expect(
    await sql`SELECT 1 FROM email_messages WHERE resend_email_id IN (${first.data.email_id}, ${unknown.data.email_id})`,
  ).toHaveLength(0);
  expect(
    await sql`SELECT 1 FROM jobs WHERE idempotency_key LIKE ${`%:${unknown.data.email_id}`}`,
  ).toHaveLength(0);

  const responses = await Promise.all([
    POST(request(first)),
    POST(request(first)),
    POST(request(first)),
  ]);
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
  expect(
    await sql`SELECT 1 FROM jobs WHERE idempotency_key LIKE ${`%:${first.data.email_id}`}`,
  ).toHaveLength(2);
  expect(
    await persistConfiguration(admin, sarah.id, 1, { ...sarah.config, name: 'Sarah Renamed' }),
  ).toBe(true);
  await setEmailEnabled(admin, sarah.id, false);
  const disabled = delivery([sarah.address]);
  expect((await POST(request(disabled))).status).toBe(200);
  expect(
    await sql`SELECT 1 FROM email_messages WHERE resend_email_id=${disabled.data.email_id}`,
  ).toHaveLength(0);
  await setEmailEnabled(admin, sarah.id, true);
  const [mailbox] = await sql`SELECT address FROM email_mailboxes WHERE agent_id=${sarah.id}`;
  expect(mailbox!.address).toBe(sarah.address);

  // Disable cancelled Sarah's pending draft. Resend still supplies the stored body for both recipients.
  const fixtures = new Map<string, ResendFixture>([
    [
      first.data.email_id,
      {
        html: '<p>Invoice</p><img src="https://example.test/pixel">',
        headers: { 'Message-ID': '<one@example.test>' },
      },
    ],
  ]);
  expect((await receive(fixtures, 2)).calls).toBe(2);
  await draft(model, 1);
  const [skipped] =
    await sql`SELECT body, skip_reason, run_id FROM email_messages WHERE resend_email_id=${first.data.email_id} AND agent_id=${sarah.id}`;
  expect(skipped).toMatchObject({
    body: 'Invoice',
    skip_reason: 'Agent email is disabled.',
    run_id: null,
  });

  const child = delivery([sarah.address], new Date(base.getTime() + 1000));
  expect((await POST(request(child))).status).toBe(200);
  fixtures.set(child.data.email_id, {
    html: '<p>Invoice</p>',
    headers: { 'MESSAGE-ID': '<two@example.test>', 'IN-REPLY-TO': '<one@example.test>' },
  });
  await receive(fixtures, 1);
  const [queued] =
    await sql`SELECT run_id, configuration_id FROM email_messages WHERE resend_email_id=${child.data.email_id}`;
  // The queued run keeps its receipt-time snapshot even if the admin saves another version.
  expect(
    await persistConfiguration(admin, sarah.id, 2, { ...sarah.config, name: 'Sarah Current' }),
  ).toBe(true);
  // Email drafts are owned by email.draft — simulation.run must refuse them.
  await expect(processSimulationJob({ runId: queued!.run_id }, () => model)).rejects.toThrow(
    'email runs must use email.draft',
  );
  const [stillQueued] = await sql`SELECT status FROM simulation_runs WHERE id=${queued!.run_id}`;
  expect(stillQueued!.status).toBe('queued');
  const groundedModel: ModelCall = Object.assign(
    async (input: Parameters<ModelCall>[0]) => {
      expect(input.system).toContain('Sarah Renamed');
      expect(input.input).toContain('previousMessages');
      return model(input);
    },
    { quote: model.quote },
  );
  await draft(groundedModel, 1);

  const parent = delivery([sarah.address], new Date(base.getTime() + 2000));
  const lateChild = delivery([sarah.address], new Date(base.getTime() + 3000));
  expect((await POST(request(lateChild))).status).toBe(200);
  fixtures.set(lateChild.data.email_id, {
    html: '<p>Invoice</p>',
    headers: { References: '<three@example.test>', 'Message-Id': '<four@example.test>' },
  });
  await receive(fixtures, 1);
  await draft(model, 1);
  expect((await POST(request(parent))).status).toBe(200);
  fixtures.set(parent.data.email_id, {
    html: '<p>Invoice</p>',
    headers: { 'Message-Id': '<three@example.test>' },
  });
  await receive(fixtures, 1);
  await draft(model, 1);

  const rows = await sql`SELECT m.agent_id,m.thread_id,m.resend_email_id,r.origin,r.status,r.result
    FROM email_messages m LEFT JOIN simulation_runs r ON r.id=m.run_id
    WHERE m.agent_id IN (${sarah.id}, ${john.id}) ORDER BY received_at`;
  expect(rows).toHaveLength(5);
  const sarahRows = rows.filter((row) => row.agent_id === sarah.id);
  expect(sarahRows[0]!.thread_id).toBe(sarahRows[1]!.thread_id);
  expect(sarahRows[2]!.thread_id).toBe(sarahRows[3]!.thread_id);
  expect(sarahRows[1]!.thread_id).not.toBe(sarahRows[2]!.thread_id);
  const live = rows.find((row) => row.agent_id === john.id)!;
  expect(live.thread_id).not.toBe(sarahRows[0]!.thread_id);
  expect(draftAnswerFromResult(live.result)?.sources).toEqual([]);
  for (const row of [live, ...sarahRows.slice(1)]) {
    expect(row).toMatchObject({ origin: 'email', status: 'completed' });
    expect(row.result.actions).toEqual([]);
    expect(draftAnswerFromResult(row.result)?.answer).toContain('under Billing');
  }
  expect(draftAnswerFromResult(sarahRows[1]!.result)?.sources[0]).toMatchObject({
    sourceFilename: 'billing.md',
  });
  const intents = await sql`SELECT action_type, decision, review_status FROM action_intents
      WHERE agent_id IN (${sarah.id}, ${john.id})
        AND action_type NOT IN ('knowledge.search')`;
  expect(intents.length).toBeGreaterThan(0);
  expect(intents.every((row) => row.action_type === 'email.send')).toBe(true);
  expect(
    intents.every((row) => row.decision === 'needs-approval' && row.review_status === 'pending'),
  ).toBe(true);
  expect(
    await sql`SELECT 1 FROM outbound_actions WHERE agent_id IN (${sarah.id}, ${john.id})`,
  ).toHaveLength(0);
  const [usage] =
    await sql`SELECT sum(requests) AS requests, sum(outbound_actions) AS outbound FROM usage_counters WHERE agent_id IN (${sarah.id}, ${john.id})`;
  expect(Number(usage!.requests)).toBeGreaterThanOrEqual(8);
  expect(Number(usage!.outbound)).toBe(0);
});

test('busy email waits without refetching, while pause, stop and quotas skip drafting', async () => {
  const sarah = await createAgent('Sarah queue fixture');
  const active = await enqueueSimulation({
    actor: admin,
    agentId: sarah.id,
    configurationId: sarah.version,
    input: 'Occupy the slot',
  });
  expect(active.runId).toBeDefined();
  const event = delivery([sarah.address]);
  expect((await POST(request(event))).status).toBe(200);
  const fixtures = new Map<string, ResendFixture>([[event.data.email_id, { text: 'Invoice' }]]);
  const first = await receive(fixtures, 1);
  expect(first.calls).toBe(1);
  expect(first.results[0]?.deferUntil.getTime()).toBeGreaterThan(Date.now());
  const [deferred] =
    await sql`SELECT j.attempts,m.waiting_for_capacity,m.run_id FROM email_messages m JOIN jobs j ON j.id=m.receive_job_id WHERE m.resend_email_id=${event.data.email_id}`;
  expect(deferred).toMatchObject({ attempts: 0, waiting_for_capacity: true, run_id: null });
  await sql`UPDATE simulation_runs SET status='completed' WHERE id=${active.runId!}`;
  await sql`UPDATE jobs SET available_at=now() WHERE payload->>'agentId'=${sarah.id} AND type='email.receive'`;
  expect((await receive(fixtures, 1)).calls).toBe(0);
  await draft(model, 1);

  const paused = delivery([sarah.address]);
  await persistLifecycle(admin, sarah.id, 'paused');
  expect((await POST(request(paused))).status).toBe(200);
  await persistLifecycle(admin, sarah.id, 'shadow');
  fixtures.set(paused.data.email_id, { text: 'Arrived while paused' });

  const stopped = delivery([sarah.address]);
  expect((await POST(request(stopped))).status).toBe(200);
  await persistLifecycle(admin, sarah.id, 'stopped');
  await persistLifecycle(admin, sarah.id, 'live');
  fixtures.set(stopped.data.email_id, { text: 'Stopped before execution' });

  const capped = delivery([sarah.address]);
  await sql`UPDATE agents SET budgets=budgets || '{"dailyRequests":0}'::jsonb WHERE id=${sarah.id}`;
  expect((await POST(request(capped))).status).toBe(200);
  fixtures.set(capped.data.email_id, { text: 'Arrived at quota' });
  await receive(fixtures, 3);
  const rows = await sql`SELECT resend_email_id,skip_reason,run_id,body FROM email_messages
    WHERE resend_email_id IN (${paused.data.email_id},${stopped.data.email_id},${capped.data.email_id})`;
  const reasons = new Map(rows.map((row) => [row.resend_email_id, row.skip_reason]));
  expect(reasons.get(paused.data.email_id)).toBe('Agent is paused.');
  expect(reasons.get(stopped.data.email_id)).toBe('Agent is stopped.');
  expect(reasons.get(capped.data.email_id)).toMatch(/request/i);
  expect(rows.every((row) => row.run_id === null && row.body)).toBe(true);
});

test('queue failure rolls back the entire webhook event and provider failure can retry', async () => {
  const sarah = await createAgent('Sarah retry fixture');
  const event = delivery([sarah.address]);
  await sql.unsafe(`CREATE FUNCTION reject_fixture_email_job() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.idempotency_key = 'email.receive:${sarah.id}:${event.data.email_id}' THEN
        RAISE EXCEPTION 'Fixture enqueue failure';
      END IF;
      RETURN NEW;
    END $$`);
  try {
    await sql`CREATE TRIGGER reject_fixture_email_job BEFORE INSERT ON jobs
      FOR EACH ROW EXECUTE FUNCTION reject_fixture_email_job()`;
    expect((await POST(request(event))).status).toBe(503);
    expect(await sql`SELECT 1 FROM email_messages WHERE agent_id=${sarah.id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM email_threads WHERE agent_id=${sarah.id}`).toHaveLength(0);
  } finally {
    await sql`DROP TRIGGER IF EXISTS reject_fixture_email_job ON jobs`;
    await sql`DROP FUNCTION reject_fixture_email_job()`;
  }
  expect((await POST(request(event))).status).toBe(200);
  const [claimed] = await claimJobs({ workerId, types: [EMAIL_RECEIVE_JOB] });
  await expect(
    processEmailReceiveJob(claimed!, workerId, signal, async () => {
      throw new Error('Resend service unavailable');
    }),
  ).rejects.toThrow('Resend service unavailable');
  await failJob(claimed!.id, workerId, 'Failed to retrieve email');
  await sql`UPDATE jobs SET available_at=now() WHERE id=${claimed!.id}`;
  const [retry] = await claimJobs({ workerId, types: [EMAIL_RECEIVE_JOB] });
  expect(retry!.attempts).toBe(2);
  await processEmailReceiveJob(claimed!, workerId, signal, async () => ({
    body: 'stale lease',
    messageId: null,
    inReplyTo: [],
    referenceIds: [],
  }));
  const [before] =
    await sql`SELECT body,run_id FROM email_messages WHERE resend_email_id=${event.data.email_id}`;
  expect(before).toMatchObject({ body: null, run_id: null });
  await processEmailReceiveJob(retry!, workerId, signal, async () => ({
    body: 'successful retry',
    messageId: null,
    inReplyTo: [],
    referenceIds: [],
  }));
  await completeJob(retry!.id, workerId);
  await draft(model, 1);
  const [after] = await sql`SELECT m.body,r.status FROM email_messages m
    JOIN simulation_runs r ON r.id=m.run_id WHERE m.resend_email_id=${event.data.email_id}`;
  expect(after).toMatchObject({ body: 'successful retry', status: 'completed' });
});

const ssoRequirement = 'Northstar requires SSO for its pilot.';
const ssoTopic = 'SSO requirement';

async function incomingMemorySource(address: string, body: string, date = new Date()) {
  const event = delivery([address], date);
  expect((await POST(request(event))).status).toBe(200);
  await receive(new Map([[event.data.email_id, { text: body }]]), 1);
  const [message] = await sql<{ id: string; run_id: string }[]>`
    SELECT id,run_id FROM email_messages WHERE resend_email_id=${event.data.email_id}
  `;
  return message!;
}

function memoryProposal(fact: string, quote = fact) {
  return { subjectKind: 'company', subject: 'Northstar', topic: ssoTopic, fact, quote };
}

function memoryInference(
  proposals: unknown[] = [],
  inspect?: (request: Parameters<ModelCall>[0]) => Promise<void> | void,
): ModelCall {
  return Object.assign(
    async (request: Parameters<ModelCall>[0]) => {
      await inspect?.(request);
      const recall = JSON.parse(request.input).untrustedMemories;
      return {
        inputTokens: 5,
        outputTokens: 2,
        costMicros: 1,
        memoryCandidates: proposals,
        decision: {
          relevant: false,
          priority: 0,
          reason: 'No reply needed',
          actions: [],
          ...(request.grounded
            ? {
                answer: recall?.[0]?.fact ?? null,
                citations: [],
                memoryCitations: recall?.length ? [1] : [],
              }
            : {}),
        },
      };
    },
    { quote: model.quote },
  );
}

async function playgroundMemory(
  agent: Awaited<ReturnType<typeof createAgent>>,
  input: string,
  inference: ModelCall,
) {
  const run = await enqueueSimulation({
    actor: admin,
    agentId: agent.id,
    configurationId: agent.version,
    input,
  });
  expect(run.runId).toBeDefined();
  await processSimulationJob({ runId: run.runId! }, () => inference);
  const [row] = await sql`SELECT status, result FROM simulation_runs WHERE id=${run.runId!}`;
  expect(row!.status).toBe('completed');
  // This helper executes the runtime directly, so acknowledge the job it admitted.
  await sql`UPDATE jobs SET status='completed' WHERE payload->>'runId'=${run.runId!}`;
  return row!.result;
}

test('inbound memory commits once across a finalization retry and recalls only inside the owning agent', async () => {
  const sarah = await createAgent('Sarah memory');
  const john = await createAgent('John memory');
  await sql`INSERT INTO knowledge_libraries (id,name) VALUES (${memoryLibraryId},'Northstar pilot')`;
  await sql`INSERT INTO knowledge_library_grants (library_id,agent_id)
    VALUES (${memoryLibraryId},${sarah.id}),(${memoryLibraryId},${john.id})`;
  const [doc] = await sql`INSERT INTO knowledge_documents
    (library_id,filename,title,content_kind,mime_type,byte_size,object_key,status)
    VALUES (${memoryLibraryId},'pilot.md','Pilot','markdown','text/markdown',15,'fixture/pilot.md','ready') RETURNING id`;
  await sql`INSERT INTO knowledge_chunks(document_id,chunk_index,content,content_hash,
    source_filename,source_title,start_offset,end_offset)
    VALUES (${doc!.id},0,'Northstar pilot','fixture-hash','pilot.md','Pilot',0,15)`;
  for (const agent of [sarah, john]) {
    const { hits } = await searchKnowledge({
      agentId: agent.id,
      query: 'Northstar pilot',
      embedQuery: stubEmbedders().embedOne,
    });
    expect(hits).toMatchObject([{ documentId: doc!.id, content: 'Northstar pilot' }]);
  }
  const original = await incomingMemorySource(sarah.address, ssoRequirement);
  let paidCalls = 0;
  const capture = memoryInference(
    [
      memoryProposal(ssoRequirement),
      { ...memoryProposal('Unverified detail.', 'This quote was fabricated.'), topic: 'Timeline' },
      { ...memoryProposal('Consent granted.', ssoRequirement), topic: 'Permissions' },
    ],
    (request) => {
      expect(request.captureMemory).toBe(true);
      paidCalls++;
    },
  );
  await sql.unsafe(`CREATE FUNCTION reject_fixture_memory_completion() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${original.run_id}' AND NEW.status = 'completed' THEN
        RAISE EXCEPTION 'Fixture completion failure';
      END IF;
      RETURN NEW;
    END $$`);
  try {
    await sql`CREATE TRIGGER reject_fixture_memory_completion BEFORE UPDATE ON simulation_runs
      FOR EACH ROW EXECUTE FUNCTION reject_fixture_memory_completion()`;
    await expect(processEmailDraftJob({ runId: original.run_id }, () => capture)).rejects.toThrow(
      /retry/i,
    );
    expect(await sql`SELECT 1 FROM agent_memories WHERE agent_id=${sarah.id}`).toHaveLength(0);
    expect(
      await sql`SELECT 1 FROM action_intents WHERE run_id=${original.run_id} AND action_type=${MEMORY_CAPTURE}`,
    ).toHaveLength(0);
  } finally {
    await sql`DROP TRIGGER IF EXISTS reject_fixture_memory_completion ON simulation_runs`;
    await sql`DROP FUNCTION reject_fixture_memory_completion()`;
  }
  await draft(capture, 1);
  await processEmailDraftJob({ runId: original.run_id }, () => capture);
  expect(paidCalls).toBe(1);
  const entries = await sql`SELECT * FROM agent_memories WHERE agent_id=${sarah.id}`;
  expect(entries).toHaveLength(1);
  const [entry] = entries;
  expect(entry).toMatchObject({
    source_kind: 'email',
    source_id: original.id,
    run_id: original.run_id,
    fact: ssoRequirement,
  });
  expect(await selectAgentMemoryEvidence(sarah.id, entry!.id, entry!.revision)).toMatchObject({
    source: { id: original.id, body: ssoRequirement },
    quote: ssoRequirement,
  });
  expect(await selectAgentMemoryEvidence(john.id, entry!.id, entry!.revision)).toBeNull();
  const [completed] = await sql`SELECT result FROM simulation_runs WHERE id=${original.run_id}`;
  expect(completed!.result.pendingMemories).toBeUndefined();

  const followUp = await incomingMemorySource(
    sarah.address,
    'Can you confirm the Northstar pilot login requirements?',
  );
  const checkRecall = Object.assign(
    async (request: Parameters<ModelCall>[0]) => {
      expect(JSON.parse(request.input).untrustedMemories).toMatchObject([{ fact: ssoRequirement }]);
      expect(request.system).toContain('untrusted reference data');
      if (request.stage === 'main') {
        expect(request.system).toContain('ask for clarification or acknowledge uncertainty');
        expect(request.system).not.toContain('Where the sources or memories do not support');
      }
      return model(request);
    },
    { quote: model.quote },
  );
  await draft(checkRecall, 1);
  const [later] = await sql`SELECT result FROM simulation_runs WHERE id=${followUp.run_id}`;
  expect(later!.result.memory).toEqual([{ id: entry!.id, revision: entry!.revision }]);

  const deeper = await incomingMemorySource(sarah.address, 'Can you clarify item ZQ579?');
  await draft(
    Object.assign(
      async (request: Parameters<ModelCall>[0]) => {
        if (request.stage === 'evaluator') return model(request);
        expect(JSON.parse(request.input).untrustedMemories).toBeUndefined();
        const search = async (name: string, query: string) => {
          const execute = request.tools?.[name]?.execute;
          expect(execute).toBeDefined();
          return execute!({ query }, { toolCallId: name, messages: [], context: undefined });
        };
        expect(await search('search_history', 'Northstar SSO')).toMatchObject({
          untrustedResults: expect.arrayContaining([
            expect.objectContaining({ excerpt: ssoRequirement }),
          ]),
        });
        expect(await search('search_memory', 'Northstar SSO')).toMatchObject({
          untrustedResults: [{ fact: ssoRequirement, memoryCitation: 1 }],
        });
        expect(await search('search_knowledge', 'Northstar pilot')).toMatchObject({
          untrustedResults: [{ passage: 'Northstar pilot', citation: 1 }],
        });
        const response = await model(request);
        return {
          ...response,
          decision: {
            ...response.decision,
            answer: ssoRequirement,
            citations: [1],
            memoryCitations: [1],
          },
        };
      },
      { quote: model.quote },
    ),
    1,
  );
  const [deepResult] =
    await sql`SELECT status,result FROM simulation_runs WHERE id=${deeper.run_id}`;
  expect(deepResult!.status).toBe('completed');
  expect(draftAnswerFromResult(deepResult!.result)).toMatchObject({
    memories: [{ id: entry!.id, revision: entry!.revision }],
    sources: [{ documentId: doc!.id }],
  });
  expect(deepResult!.result.toolCalls.slice(-3)).toEqual(
    ['history.search', 'memory.search', 'knowledge.search'].map((tool) => ({
      tool,
      args: {},
      policy: 'allow',
      result: { hitCount: 1 },
    })),
  );

  const asked = 'Does the Northstar pilot require SSO?';
  await sql`UPDATE agent_configurations SET config = config || '{"xSearchQuery":"*"}'::jsonb
    WHERE id=${sarah.version}`;
  const adapter = createFixtureXSearchAdapter([{ id: '32001', text: asked, raw: {} }]);
  expect(
    await processDiscoveryPoll({ payload: { agentId: sarah.id } }, signal, {
      adapter,
      evaluate: true,
    }),
  ).toMatchObject({ evaluated: 1 });
  const [discovery] = await sql`SELECT run_id FROM source_events WHERE agent_id=${sarah.id}`;
  await processSimulationJob({ runId: discovery!.run_id }, () =>
    memoryInference([], (request) => {
      const input = JSON.parse(request.input);
      expect(input.untrustedMemorySource).toEqual([asked]);
      expect(input.untrustedMemories).toBeUndefined();
    }),
  );
  const [crossChannel] =
    await sql`SELECT status,result FROM simulation_runs WHERE id=${discovery!.run_id}`;
  expect(crossChannel!.status).toBe('completed');
  expect(crossChannel!.result.memory).toBeUndefined();

  const outside = await playgroundMemory(
    john,
    asked,
    memoryInference([memoryProposal(ssoRequirement)]),
  );
  expect(outside.memory).toBeUndefined();
  const inside = await playgroundMemory(
    sarah,
    asked,
    memoryInference([memoryProposal('Fake new requirement.')]),
  );
  expect(draftAnswerFromResult(inside)).toMatchObject({
    answer: ssoRequirement,
    memories: [{ id: entry!.id, revision: entry!.revision }],
  });
  expect(
    playgroundChunksFromResult(inside, createPlaygroundStreamProgress(), { status: 'completed' }),
  ).toContainEqual({
    type: 'tool-output-available',
    toolCallId: 'memory.search',
    output: [{ id: entry!.id, revision: entry!.revision }],
  });
  expect([...(await sql`SELECT fact FROM agent_memories WHERE agent_id=${sarah.id}`)]).toEqual([
    { fact: ssoRequirement },
  ]);
  expect(await sql`SELECT 1 FROM agent_memories WHERE agent_id=${john.id}`).toHaveLength(0);

  expect(
    await saveAgentMemory(admin, { agentId: john.id, id: entry!.id, revision: entry!.revision }),
  ).toHaveProperty('error');
  expect(
    await saveAgentMemory(admin, { agentId: sarah.id, id: entry!.id, revision: entry!.revision }),
  ).toHaveProperty('message');
  await processEmailDraftJob({ runId: original.run_id }, () => capture);
  const removed = await playgroundMemory(sarah, asked, memoryInference());
  expect(removed.memory).toBeUndefined();
  expect(await selectAgentMemoryEvidence(sarah.id, entry!.id, entry!.revision)).toBeNull();
});

test('newer evidence updates a learned revision, corrections take precedence, and replay shares one snapshot', async () => {
  const sarah = await createAgent('Sarah memory revisions');
  const older = new Date(Date.now() - 60_000);
  const original = await incomingMemorySource(sarah.address, ssoRequirement, older);
  await draft(memoryInference([memoryProposal(ssoRequirement)]), 1);
  const [initial] = await sql`SELECT id,revision FROM agent_memories WHERE agent_id=${sarah.id}`;
  const newest = 'Northstar no longer requires SSO for its pilot.';
  await incomingMemorySource(sarah.address, newest);
  await draft(memoryInference([memoryProposal(newest)]), 1);
  const [learned] =
    await sql`SELECT id,revision,fact FROM agent_memories WHERE agent_id=${sarah.id}`;
  expect(learned).toMatchObject({ id: initial!.id, fact: newest });
  expect(learned!.revision).not.toBe(initial!.revision);
  expect(await selectAgentMemoryEvidence(sarah.id, initial!.id, initial!.revision)).toMatchObject({
    quote: ssoRequirement,
    source: { id: original.id, body: ssoRequirement },
  });
  expect(await selectAgentMemoryEvidence(sarah.id, learned!.id, learned!.revision)).toMatchObject({
    quote: newest,
    source: { body: newest },
  });
  const otherAgent = await createAgent('Other evidence reader');
  expect(await selectAgentMemoryEvidence(otherAgent.id, initial!.id, initial!.revision)).toBeNull();
  await sql`UPDATE email_messages SET body='Redacted' WHERE id=${original.id}`;
  expect(await selectAgentMemoryEvidence(sarah.id, initial!.id, initial!.revision)).toBeNull();
  expect(await selectAgentMemoryEvidence(sarah.id, learned!.id, learned!.revision)).not.toBeNull();
  await incomingMemorySource(sarah.address, ssoRequirement, older);
  await draft(memoryInference([memoryProposal(ssoRequirement)]), 1);
  expect([
    ...(await sql`SELECT revision,fact FROM agent_memories WHERE id=${learned!.id}`),
  ]).toEqual([{ revision: learned!.revision, fact: newest }]);

  expect(
    await persistConfiguration(admin, sarah.id, 1, { ...sarah.config, name: 'Sarah memory v2' }),
  ).toBe(true);
  const [second] =
    await sql`SELECT id FROM agent_configurations WHERE agent_id=${sarah.id} AND version=2`;
  const caseInput = 'What does Northstar require for its pilot?';
  const saved = await saveEvaluationCase({
    actor: admin,
    agentId: sarah.id,
    title: 'Pilot',
    sourceKind: 'playground',
    caseInput,
  });
  if (!('caseId' in saved)) throw new Error(saved.error);
  const comparison = await startEvaluationComparison({
    actor: admin,
    agentId: sarah.id,
    caseId: saved.caseId,
    leftConfigurationId: sarah.version,
    rightConfigurationId: second!.id,
  });
  if (!('comparisonId' in comparison)) throw new Error(comparison.error);

  const key = { agentId: sarah.id, id: learned!.id, revision: learned!.revision };
  const correctedFact = 'Northstar requires a SAML integration for its pilot.';
  let replayCalls = 0;
  await processEvaluationReplayJob({ comparisonId: comparison.comparisonId }, () =>
    memoryInference([memoryProposal(ssoRequirement)], async (request) => {
      expect(request.captureMemory).toBe(false);
      expect(JSON.parse(request.input).untrustedMemories).toMatchObject([{ fact: newest }]);
      if (++replayCalls === 1) {
        expect(
          await saveAgentMemory(admin, key, {
            fact: correctedFact,
            expiresOn: null,
            reviewOn: '2000-01-01',
          }),
        ).toHaveProperty('message');
      }
    }),
  );
  expect(replayCalls).toBe(4);
  const [finished] =
    await sql`SELECT status,memory_snapshot FROM evaluation_comparisons WHERE id=${comparison.comparisonId}`;
  expect(finished).toEqual({ status: 'completed', memory_snapshot: null });
  const [corrected] =
    await sql`SELECT id,revision,fact FROM agent_memories WHERE agent_id=${sarah.id}`;
  expect(corrected!.fact).toBe(correctedFact);
  expect(
    draftAnswerFromResult(await playgroundMemory(sarah, caseInput, memoryInference()))?.answer,
  ).toBe(correctedFact);

  await incomingMemorySource(sarah.address, ssoRequirement);
  await draft(memoryInference([memoryProposal(ssoRequirement)]), 1);
  expect([...(await sql`SELECT fact FROM agent_memories WHERE id=${corrected!.id}`)]).toEqual([
    { fact: correctedFact },
  ]);

  const expiry = { agentId: sarah.id, id: corrected!.id, revision: corrected!.revision };
  expect(
    await saveAgentMemory(admin, expiry, {
      fact: correctedFact,
      expiresOn: '2000-01-01',
      reviewOn: null,
    }),
  ).toHaveProperty('message');
  expect((await playgroundMemory(sarah, caseInput, memoryInference())).memory).toBeUndefined();
  await processMemoryEmbedding(expiry);
  const [expired] = await sql`SELECT embedding FROM agent_memories WHERE id=${corrected!.id}`;
  expect(expired!.embedding).toBeNull();
});

test('pgvector finds owned facts and memory capture requires a production run with evidence', async () => {
  const sarah = await createAgent('Sarah semantic memory');
  const john = await createAgent('John semantic memory');
  const original = await incomingMemorySource(sarah.address, ssoRequirement);
  await draft(memoryInference([memoryProposal(ssoRequirement)]), 1);
  const [entry] = await sql`SELECT id,revision FROM agent_memories WHERE agent_id=${sarah.id}`;
  const stub = process.env.KNOWLEDGE_EMBEDDING_STUB;
  process.env.KNOWLEDGE_EMBEDDING_STUB = 'true';
  try {
    await processMemoryEmbedding({ agentId: sarah.id, id: entry!.id, revision: entry!.revision });
    const [indexed] = await sql`SELECT embedding_model FROM agent_memories WHERE id=${entry!.id}`;
    expect(indexed!.embedding_model).toStartWith('stub:');
    const query = 'federated authentication';
    const embedding = JSON.stringify(await stubEmbedders().embedOne(query));
    await sql`UPDATE agent_memories SET embedding=${embedding}::vector WHERE id=${entry!.id}`;
    const owner = await playgroundMemory(sarah, query, memoryInference());
    expect(draftAnswerFromResult(owner)?.answer).toBe(ssoRequirement);
    expect((await playgroundMemory(john, query, memoryInference())).memory).toBeUndefined();
  } finally {
    if (stub === undefined) delete process.env.KNOWLEDGE_EMBEDDING_STUB;
    else process.env.KNOWLEDGE_EMBEDDING_STUB = stub;
  }

  const token = randomUUID();
  for (const origin of ['playground', 'replay', 'discovery']) {
    const [run] = await sql`INSERT INTO simulation_runs
      (agent_id,configuration_id,origin,input,status,actor,result,expires_at,execution_token)
      VALUES (${sarah.id},${sarah.version},${origin},'Untrusted input','running',${admin},
        '{"steps":[],"actions":[],"error":null}'::jsonb,now()+interval '5 minutes',${token}) RETURNING id`;
    if (origin !== 'discovery') {
      await sql`INSERT INTO source_events (agent_id, provider, provider_event_id, payload, text, run_id)
        VALUES (${sarah.id},'x',${randomUUID()},'{}',${ssoRequirement},${run!.id})`;
    }
    const ctx = await loadPolicyContext(sarah.id, admin, run!.id, db());
    expect(
      await authorizeAction(ctx!, {
        type: MEMORY_CAPTURE,
        idempotencyKey: `capture-fixture:${run!.id}`,
        executionToken: token,
      }),
    ).toMatchObject({ decision: 'deny' });
    await sql`UPDATE simulation_runs SET status='completed' WHERE id=${run!.id}`;
  }
  await sql`UPDATE email_messages SET body=NULL WHERE id=${original.id}`;
  expect(await sql`SELECT id FROM agent_memories WHERE id=${entry!.id}`).toHaveLength(0);
  expect((await playgroundMemory(sarah, ssoRequirement, memoryInference())).memory).toBeUndefined();
});

const emptyDraftDecision = {
  relevant: true,
  priority: 0.7,
  reason: 'A support conversation',
  actions: [],
};

async function sarahCommitment(
  tool: 'wait_for_reply' | 'schedule_follow_up' = 'wait_for_reply',
  existing?: { agent: Awaited<ReturnType<typeof createAgent>>; parent: string },
) {
  const sarah = existing?.agent ?? (await createAgent('Sarah'));
  expect(await persistCommitmentGrant(admin, sarah.id, `commitments.${tool}`, true)).toEqual({
    message: 'Commitment permission saved.',
  });

  const first = delivery([sarah.address]);
  const parent = `<${first.data.email_id}@example.test>`;
  expect((await POST(request(first))).status).toBe(200);
  await receive(
    new Map([
      [
        first.data.email_id,
        {
          text: 'Can you help me check an invoice?',
          headers: {
            'Message-ID': parent,
            ...(existing ? { 'In-Reply-To': existing.parent } : {}),
          },
        },
      ],
    ]),
    1,
  );
  const call: ModelCall = async (modelRequest) => {
    if (modelRequest.stage === 'main') {
      const exec = modelRequest.tools?.[tool]?.execute;
      const otherTool = tool === 'wait_for_reply' ? 'schedule_follow_up' : 'wait_for_reply';
      expect(modelRequest.tools?.[otherTool]).toBeUndefined();
      expect(exec).toBeDefined();
      if (!exec) throw new Error('Expected a conversation commitment tool.');
      const args = {
        subject: 'Check back about the invoice',
        note: 'Ask if the customer still needs help.',
        dueAt: new Date(Date.now() + 60_000).toISOString(),
      };
      const context = {
        messages: [],
        toolCallId: 'request-commitment',
        abortSignal: signal,
        context: undefined,
      };
      const one = await exec(args, context);
      expect(one).toMatchObject({ status: 'scheduled' });
      expect(await exec(args, { ...context, toolCallId: 'duplicate' })).toEqual(one);
    }
    return {
      decision: {
        ...emptyDraftDecision,
        ...(modelRequest.stage === 'main' ? { answer: null, citations: [] } : {}),
      },
      inputTokens: 3,
      outputTokens: 3,
      costMicros: 1,
    };
  };
  call.quote = model.quote;
  await draft(call, 1);
  const rows = await sql<{ id: string; job_id: string; conversation_id: string }[]>`
    SELECT id, job_id, conversation_id FROM follow_ups WHERE agent_id=${sarah.id}
  `;
  expect(rows).toHaveLength(1);
  return { sarah, parent, commitment: rows[0]! };
}

function replyDelivery(address: string, parent: string, text: string) {
  const event = delivery([address]);
  return {
    event,
    fixtures: new Map([
      [
        event.data.email_id,
        {
          text,
          headers: {
            'Message-ID': `<${event.data.email_id}@example.test>`,
            'In-Reply-To': parent,
            References: parent,
          },
        },
      ],
    ]),
  };
}

async function claimCommitmentTimer(jobId: string, worker: string) {
  const candidates = await claimJobs({ workerId: worker, types: [FOLLOW_UP_JOB_TYPE], limit: 20 });
  const job = candidates.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error('Expected a claimed commitment timer.');
  for (const candidate of candidates) {
    if (candidate.id !== jobId) await releaseClaim(candidate.id, worker);
  }
  return job;
}

test('Sarah’s persisted reply closes the wait once and becomes the next channel run’s evidence', async () => {
  const { sarah, parent, commitment } = await sarahCommitment();
  const other = await createAgent('Different agent');
  const unrelated = delivery([sarah.address]);
  const wrongAgent = replyDelivery(other.address, parent, 'A reply for another agent.');
  expect((await POST(request(unrelated))).status).toBe(200);
  expect((await POST(request(wrongAgent.event))).status).toBe(200);
  await receive(
    new Map<string, ResendFixture>([
      [unrelated.data.email_id, { text: 'Same sender and subject, different thread.' }],
      ...wrongAgent.fixtures,
    ]),
    2,
  );
  await draft(model, 2);
  expect((await sql`SELECT status FROM follow_ups WHERE id=${commitment.id}`)[0]?.status).toBe(
    'scheduled',
  );

  // A claimed timer must check the real deadline and can lose its claim to the reply.
  await sql`UPDATE jobs SET available_at=now() WHERE id=${commitment.job_id}`;
  const timer = await claimCommitmentTimer(commitment.job_id, workerId);
  const reply = replyDelivery(sarah.address, parent, 'I found the invoice. Thank you.');
  const deliveries = await Promise.all([POST(request(reply.event)), POST(request(reply.event))]);
  expect(deliveries.map(({ status }) => status)).toEqual([200, 200]);
  const [, received] = await Promise.all([
    processFollowUpJob(timer, signal),
    receive(reply.fixtures, 1),
  ]);
  expect(received.calls).toBe(1);

  let evidenceSeen = false;
  const continuation: ModelCall = async (modelRequest) => {
    const input = JSON.parse(modelRequest.input);
    expect(input.untrustedInput).toContain('I found the invoice. Thank you.');
    expect(input.untrustedResolvedCommitments).toEqual([
      {
        subject: 'Check back about the invoice',
        note: 'Ask if the customer still needs help.',
      },
    ]);
    evidenceSeen = true;
    return model(modelRequest);
  };
  continuation.quote = model.quote;
  await draft(continuation, 1);
  expect(evidenceSeen).toBe(true);

  const [row] = await sql`
    SELECT f.status, f.outcome_kind, f.draft_run_id, f.continuation_run_id,
      e.run_id AS email_run_id, e.thread_id, j.status AS timer_status
    FROM follow_ups f JOIN email_messages e ON e.id=f.reply_email_id
    JOIN jobs j ON j.id=f.job_id WHERE f.id=${commitment.id}
  `;
  expect(row).toMatchObject({
    status: 'completed',
    outcome_kind: 'reply_received',
    thread_id: commitment.conversation_id,
    draft_run_id: null,
    timer_status: 'cancelled',
  });
  expect(row?.continuation_run_id).toBeTruthy();
  expect(row?.continuation_run_id).toBe(row?.email_run_id);
  expect(
    await sql`
    SELECT 1 FROM agent_activity_events WHERE follow_up_id=${commitment.id} AND kind <> 'follow_up.scheduled'
  `,
  ).toHaveLength(1);
  expect(
    await sql`SELECT 1 FROM action_intents WHERE idempotency_key=${`followup:${commitment.id}:draft`}`,
  ).toHaveLength(0);
});

test('a late ancestor and a redelivered Message-ID leave a newer wait open', async () => {
  const sarah = await createAgent('Sarah');
  const first = delivery([sarah.address]);
  const threadRoot = `<${first.data.email_id}@example.test>`;
  expect((await POST(request(first))).status).toBe(200);
  await receive(
    new Map([
      [
        first.data.email_id,
        {
          text: 'The first question.',
          headers: { 'Message-ID': threadRoot },
        },
      ],
    ]),
    1,
  );
  await draft(model, 1);

  const ancestor = replyDelivery(sarah.address, threadRoot, 'The reply that arrived out of order.');
  const ancestorMessageId = `<${ancestor.event.data.email_id}@example.test>`;
  const { commitment, parent } = await sarahCommitment('wait_for_reply', {
    agent: sarah,
    parent: ancestorMessageId,
  });
  expect((await POST(request(ancestor.event))).status).toBe(200);
  await receive(ancestor.fixtures, 1);
  await draft(model, 1);
  const [waiting] = await sql`
    SELECT f.status, f.conversation_id, ancestor.thread_id AS canonical_thread_id
    FROM follow_ups f JOIN email_messages ancestor ON ancestor.resend_email_id=${ancestor.event.data.email_id}
    WHERE f.id=${commitment.id}`;
  expect(waiting?.status).toBe('scheduled');
  expect(waiting?.conversation_id).toBe(waiting?.canonical_thread_id);
  expect(waiting?.conversation_id).not.toBe(commitment.conversation_id);

  const duplicate = replyDelivery(sarah.address, parent, 'Redelivery of the same message.');
  duplicate.fixtures.get(duplicate.event.data.email_id)!.headers['Message-ID'] = ancestorMessageId;
  expect((await POST(request(duplicate.event))).status).toBe(200);
  await receive(duplicate.fixtures, 1);
  await draft(model, 1);
  const [afterDuplicate] = await sql`SELECT status FROM follow_ups WHERE id=${commitment.id}`;
  expect(afterDuplicate?.status).toBe('scheduled');

  const reply = replyDelivery(sarah.address, parent, 'A new answer in the merged thread.');
  expect((await POST(request(reply.event))).status).toBe(200);
  await receive(reply.fixtures, 1);
  await draft(model, 1);
  const [resolved] = await sql`
    SELECT f.outcome_kind, e.resend_email_id
    FROM follow_ups f JOIN email_messages e ON e.id=f.reply_email_id WHERE f.id=${commitment.id}`;
  expect(resolved).toMatchObject({
    outcome_kind: 'reply_received',
    resend_email_id: reply.event.data.email_id,
  });
});

test('a matching reply waits for budget to return and continues without refetching', async () => {
  const { sarah, parent, commitment } = await sarahCommitment();
  await sql`UPDATE agents SET budgets=budgets || '{"dailyRequests":0}'::jsonb WHERE id=${sarah.id}`;
  const reply = replyDelivery(sarah.address, parent, 'The invoice has arrived.');
  expect((await POST(request(reply.event))).status).toBe(200);
  const first = await receive(reply.fixtures, 1);
  expect(first.calls).toBe(1);
  expect(first.results[0]?.deferUntil.getTime()).toBeGreaterThan(Date.now());
  const [waiting] = await sql`
    SELECT f.outcome_kind, f.continuation_run_id, e.waiting_for_capacity, e.skip_reason
    FROM follow_ups f JOIN email_messages e ON e.id=f.reply_email_id WHERE f.id=${commitment.id}`;
  expect(waiting).toMatchObject({
    outcome_kind: 'reply_received',
    continuation_run_id: null,
    waiting_for_capacity: true,
    skip_reason: null,
  });

  await sql`UPDATE agents SET budgets=${sql.json(budgetDefaults)} WHERE id=${sarah.id}`;
  await sql`UPDATE jobs SET available_at=now() WHERE payload->>'agentId'=${sarah.id} AND type='email.receive' AND status='pending'`;
  expect((await receive(reply.fixtures, 1)).calls).toBe(0);
  await draft(model, 1);
  const [continued] = await sql`
    SELECT f.continuation_run_id, e.run_id, r.status
    FROM follow_ups f JOIN email_messages e ON e.id=f.reply_email_id
    JOIN simulation_runs r ON r.id=f.continuation_run_id WHERE f.id=${commitment.id}`;
  expect(continued?.continuation_run_id).toBeTruthy();
  expect(continued?.continuation_run_id).toBe(continued?.run_id);
  expect(continued?.status).toBe('completed');
});

test('a deadline and an expired worker claim produce one Sarah follow-up approval', async () => {
  const { sarah, parent, commitment } = await sarahCommitment();
  await sql`UPDATE agents SET budgets=${sql.json({ ...budgetDefaults, maxConcurrentRuns: 2 })}
    WHERE id=${sarah.id}`;
  await sql.begin(async (tx) => {
    await tx`UPDATE follow_ups SET due_at=now() WHERE id=${commitment.id}`;
    await tx`UPDATE jobs SET available_at=now() WHERE id=${commitment.job_id}`;
  });
  const expired = await claimCommitmentTimer(commitment.job_id, 'old-worker');
  await sql`UPDATE jobs SET claim_expires_at=now()-interval '1 second' WHERE id=${expired.id}`;
  expect((await recoverExpiredLeases()).some((job) => job.id === expired.id)).toBe(true);
  const resumed = await claimCommitmentTimer(commitment.job_id, workerId);

  const reply = replyDelivery(sarah.address, parent, 'Reply at the deadline.');
  expect((await POST(request(reply.event))).status).toBe(200);
  await Promise.all([
    processFollowUpJob(expired, signal),
    processFollowUpJob(resumed, signal),
    receive(reply.fixtures, 1),
  ]);
  await processFollowUpJob(resumed, signal);
  await completeJob(resumed.id, workerId);

  const [pending] =
    await sql`SELECT draft_run_id, reply_email_id FROM follow_ups WHERE id=${commitment.id}`;
  expect(pending?.draft_run_id).toBeTruthy();
  expect(pending?.reply_email_id).toBeNull();
  const jobs = await claimJobs({ workerId, types: [EMAIL_DRAFT_JOB], limit: 2 });
  expect(jobs).toHaveLength(2);
  const generate: ModelCall = async (modelRequest) => {
    const isFollowUp = modelRequest.input.includes('Check back about the invoice');
    if (isFollowUp && modelRequest.stage === 'main') {
      expect(modelRequest.tools?.wait_for_reply).toBeUndefined();
      expect(modelRequest.system).toContain('one concise plain-text follow-up');
    }
    return {
      decision: {
        ...emptyDraftDecision,
        relevant: !isFollowUp || modelRequest.stage === 'main',
        ...(modelRequest.stage === 'main'
          ? {
              answer: isFollowUp ? 'Do you still need help finding your invoice?' : null,
              citations: [],
            }
          : {}),
      },
      inputTokens: 2,
      outputTokens: 2,
      costMicros: 1,
    };
  };
  generate.quote = model.quote;
  for (const job of jobs) {
    const claim = { workerId, jobId: job.id };
    await processEmailDraftJob(job.payload, () => generate, signal, claim);
    await processEmailDraftJob(job.payload, () => generate, signal, claim);
    await completeJob(job.id, workerId);
  }

  const results = await sql`
    SELECT f.status, f.outcome_kind, i.review_status, i.payload->>'draft' AS draft,
      i.payload->>'threadId' AS thread
    FROM follow_ups f JOIN action_intents i ON i.id=f.approval_intent_id
    WHERE f.id=${commitment.id}
  `;
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    status: 'completed',
    outcome_kind: 'draft_ready',
    review_status: 'pending',
    draft: 'Do you still need help finding your invoice?',
    thread: commitment.conversation_id,
  });
  expect(
    await sql`
    SELECT 1 FROM agent_activity_events WHERE follow_up_id=${commitment.id} AND kind <> 'follow_up.scheduled'
  `,
  ).toHaveLength(1);
  expect(await sql`SELECT 1 FROM outbound_actions WHERE agent_id=${sarah.id}`).toHaveLength(0);
});

test('cancel, pause and stop close pending conversation commitments', async () => {
  for (const lifecycle of ['cancel', 'paused', 'stopped'] as const) {
    const { sarah, commitment } = await sarahCommitment('schedule_follow_up');
    await sql`UPDATE follow_ups SET due_at=now() WHERE id=${commitment.id}`;
    await sql`UPDATE jobs SET available_at=now() WHERE id=${commitment.job_id}`;
    const timer = await claimCommitmentTimer(commitment.job_id, workerId);
    await processFollowUpJob(timer, signal);
    const [job] = await claimJobs({ workerId, types: [EMAIL_DRAFT_JOB], limit: 1 });
    expect(job).toBeDefined();

    if (lifecycle === 'cancel') {
      expect(await cancelFollowUp(admin, sarah.id, commitment.id)).toMatchObject({
        message: 'Follow-up cancelled.',
      });
    } else {
      await persistLifecycle(admin, sarah.id, lifecycle);
      await persistLifecycle(admin, sarah.id, 'shadow');
    }

    const forbidden: ModelCall = async () => {
      throw new Error('Cancelled draft attempted inference.');
    };
    await processEmailDraftJob(job!.payload, () => forbidden, signal, { workerId, jobId: job!.id });
    await processFollowUpJob(timer, signal);
    const [row] = await sql`
      SELECT f.status, f.approval_intent_id, r.status AS run_status, j.status AS job_status
      FROM follow_ups f JOIN simulation_runs r ON r.id=f.draft_run_id
      JOIN jobs j ON j.id=r.job_id WHERE f.id=${commitment.id}
    `;
    expect(row).toMatchObject({
      status: lifecycle === 'cancel' ? 'cancelled' : 'skipped',
      approval_intent_id: null,
      run_status: 'interrupted',
      job_status: 'cancelled',
    });
    expect(
      await sql`
      SELECT 1 FROM agent_activity_events WHERE follow_up_id=${commitment.id} AND kind <> 'follow_up.scheduled'
    `,
    ).toHaveLength(1);
  }
}, 15_000);

test('an unanswered Sarah conversation produces one draft awaiting administrator review', async () => {
  const { sarah, commitment } = await sarahCommitment();
  for (const tool of [PEOPLE_SEARCH, PEOPLE_INTRODUCE] as const) {
    expect(await persistPeopleGrant(admin, sarah.id, tool, true)).toHaveProperty('message');
  }
  await sql.begin(async (tx) => {
    await tx`UPDATE follow_ups SET due_at=now() WHERE id=${commitment.id}`;
    await tx`UPDATE jobs SET available_at=now() WHERE id=${commitment.job_id}`;
  });
  const timer = await claimCommitmentTimer(commitment.job_id, workerId);
  await processFollowUpJob(timer, signal);
  await processFollowUpJob(timer, signal);
  await completeJob(timer.id, workerId);
  const generate: ModelCall = (request) => {
    if (request.stage === 'main') {
      expect(request.tools?.search_people).toBeDefined();
      expect(request.tools?.propose_introduction).toBeUndefined();
      expect(request.tools?.wait_for_reply).toBeUndefined();
      expect(request.tools?.schedule_follow_up).toBeUndefined();
    }
    return model(request);
  };
  generate.quote = model.quote;
  await draft(generate, 1);
  const approvals = await sql`
    SELECT i.review_status FROM action_intents i JOIN follow_ups f ON f.approval_intent_id=i.id
    WHERE f.id=${commitment.id} AND f.reply_email_id IS NULL AND f.outcome_kind='draft_ready'
  `;
  expect(approvals).toHaveLength(1);
  expect(approvals[0]?.review_status).toBe('pending');
  expect(await sql`SELECT 1 FROM outbound_actions WHERE agent_id=${sarah.id}`).toHaveLength(0);
});
