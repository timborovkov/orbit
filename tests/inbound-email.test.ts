import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import postgres from 'postgres';

import { POST } from '@/app/api/webhooks/resend/route';
import { budgetDefaults } from '@/lib/budgets';
import { claimJobs, completeJob, failJob, releaseClaim } from '@/lib/queue/jobs';
import { fetchReceivedEmail } from '@/lib/runtime/email/provider';
import { processEmailReceiveJob } from '@/lib/runtime/email/receive';
import { EMAIL_DRAFT_JOB, EMAIL_RECEIVE_JOB } from '@/lib/runtime/email/settings';
import {
  enqueueSimulation,
  processEmailDraftJob,
  processSimulationJob,
} from '@/lib/runtime/execute';
import { draftAnswerFromResult, type ModelCall } from '@/lib/runtime/simulation';
import { setEmailEnabled } from '@/lib/server/email-mutations';
import { persistLifecycle } from '@/lib/server/lifecycle-mutations';
import { persistConfiguration } from '@/lib/server/workspace-mutations';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://orbit:orbit_dev@localhost:5432/orbit_test';
const sql = postgres(databaseUrl);
const ids: string[] = [];
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
    for (const id of ids) {
      await sql`DELETE FROM email_threads WHERE agent_id=${id}`;
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
  await processSimulationJob({ runId: queued!.run_id }, () => model);
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
  expect(
    await sql`SELECT 1 FROM action_intents WHERE agent_id IN (${sarah.id}, ${john.id})
    AND (action_type NOT IN ('knowledge.search') OR review_status IS NOT NULL)`,
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
