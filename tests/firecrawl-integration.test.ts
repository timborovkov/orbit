import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import postgres from 'postgres';

import { budgetDefaults } from '@/lib/budgets';
import { closeDb } from '@/lib/db';
import { loadPolicyContext } from '@/lib/policy/gateway';
import { claimJobs, completeJob, recoverExpiredLeases, releaseClaim } from '@/lib/queue/jobs';
import { WEB_CRAWL, WEB_CRAWL_JOB, WEB_READ, WEB_SEARCH, type WebTool } from '@/lib/research';
import { executeSimulation } from '@/lib/runtime/execute';
import { loadFirecrawlConfig } from '@/lib/runtime/research/connection';
import { processWebCrawl } from '@/lib/runtime/research/crawls';
import { webResearchTools } from '@/lib/runtime/research/tools';
import { createToolStepGate } from '@/lib/runtime/tool-steps';
import {
  cancelWebCrawl,
  persistFirecrawlCredential,
  persistWebResearchAccess,
} from '@/lib/server/research-mutations';

const ids: string[] = [];
const actor = 'firecrawl-integration@example.test';
const testOrigin = 'http://127.0.0.1:3002';
const environment = {
  DATABASE_URL: process.env.DATABASE_URL,
  FIRECRAWL_API_ORIGIN: process.env.FIRECRAWL_API_ORIGIN,
  FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
  ORBIT_ENCRYPTION_KEY: process.env.ORBIT_ENCRYPTION_KEY,
};
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://orbit:orbit_dev@127.0.0.1:5432/orbit_test';
process.env.FIRECRAWL_API_ORIGIN = testOrigin;
process.env.FIRECRAWL_API_KEY = '';
process.env.ORBIT_ENCRYPTION_KEY = 'b'.repeat(64);

const sql = postgres(process.env.DATABASE_URL);

afterAll(async () => {
  for (const id of ids) {
    await sql`delete from policy_decisions where agent_id = ${id}`;
    await sql`delete from action_intents where agent_id = ${id}`;
    await sql`delete from simulation_runs where agent_id = ${id}`;
    await sql`delete from jobs where payload->>'agentId' = ${id}`;
    await sql`delete from usage_counters where agent_id = ${id}`;
    await sql`delete from agent_configurations where agent_id = ${id}`;
    await sql`delete from agents where id = ${id}`;
  }
  await sql`delete from audit where actor = ${actor}`;
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await sql.end();
  await closeDb();
});

async function setup(grants: WebTool[]) {
  const agentId = randomUUID();
  const configId = randomUUID();
  const runId = randomUUID();
  const executionToken = randomUUID();
  ids.push(agentId);
  await sql`insert into agents (id, name, mission, budgets, enabled_tools, web_crawl_scopes)
    values (${agentId}, 'Web research integration', 'Research public docs.', ${sql.json(budgetDefaults)},
      ${sql.json(grants)}, ${sql.json(['https://1.1.1.1/docs'])})`;
  await sql`insert into agent_configurations (id, agent_id, config, version, actor)
    select ${configId}, ${agentId}, config, 1, ${actor} from templates where id = 'support'`;
  await sql`insert into simulation_runs (id, agent_id, configuration_id, status, execution_token, input, result, actor, expires_at)
    values (${runId}, ${agentId}, ${configId}, 'running', ${executionToken}, 'Research test',
      ${sql.json({ steps: [], actions: [] })}, ${actor}, now() + interval '1 minute')`;
  const policy = (await loadPolicyContext(agentId, actor, runId))!;
  return { agentId, runId, configId, policy, executionToken };
}

function mockProvider(records: string[], mode: 'complete' | 'lose' | 'cancel') {
  let cancelRequested = false;
  const document = {
    markdown: 'Documentation for a public topic.',
    metadata: { url: 'https://1.1.1.1/docs/guide', title: 'Public documentation' },
  };
  function respond(url: URL, init: RequestInit) {
    expect(url.origin).toBe(testOrigin);
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    const method = init.method;
    records.push(method + ' ' + url.pathname + url.search);
    if (url.pathname === '/v2/search')
      return Response.json({
        data: {
          web: [
            {
              url: document.metadata.url,
              title: document.metadata.title,
              description: 'Ranked result.',
            },
          ],
        },
      });
    if (url.pathname === '/v2/scrape') return Response.json({ data: document });
    if (method === 'POST') return Response.json({ id: 'local-job' });
    if (method === 'DELETE') {
      cancelRequested = true;
      return Response.json({ status: 'cancelled' });
    }
    if (mode === 'lose') return Response.json({ code: 'JOB_NOT_FOUND' }, { status: 404 });
    if (cancelRequested)
      return Response.json({ status: 'cancelled', completed: 1, total: 1, data: [document] });
    const unrelated = { ...document, metadata: { url: 'https://1.1.1.1/docsite' } };
    return Response.json({
      status: mode === 'complete' ? 'completed' : 'scraping',
      completed: 2,
      total: 2,
      data: url.search ? [unrelated] : [document],
      next: !url.search && mode === 'complete' ? '/v2/crawl/local-job?skip=1' : null,
    });
  }
  return ((url: URL, init: RequestInit) => Promise.resolve(respond(url, init))) as typeof fetch;
}

const signal = new AbortController().signal;
const call = (toolCallId: string) => ({ toolCallId, messages: [], context: {} });
function toolsFor(
  scope: Awaited<ReturnType<typeof setup>>,
  fetchRequest: typeof fetch,
  web: WebTool[],
) {
  return webResearchTools({
    ...scope,
    signal,
    fetchRequest,
    web,
    result: { steps: [], actions: [], error: null },
    gate: createToolStepGate(10),
    calls: [],
  });
}

async function work(worker: string, fetchRequest: typeof fetch) {
  const [job] = await claimJobs({ workerId: worker, types: [WEB_CRAWL_JOB], limit: 1 });
  expect(job).toBeDefined();
  const result = await processWebCrawl(job, worker, signal, fetchRequest);
  if (result) await releaseClaim(job.id, worker, undefined, result.deferUntil);
  else await completeJob(job.id, worker);
}

async function crawlFor(runId: string) {
  const [crawl] =
    await sql`select id, provider_job_id as "providerJobId", status, reason from web_crawls where run_id = ${runId}`;
  return crawl;
}

test('enforces independent grants and stores ranked search and keyless read evidence', async () => {
  const scope = await setup([WEB_SEARCH, WEB_READ]);
  const requests: string[] = [];
  const provider = mockProvider(requests, 'complete');
  expect(toolsFor(scope, provider, [WEB_READ]).web_crawl).toBeUndefined();
  const tools = toolsFor(scope, provider, [WEB_SEARCH, WEB_READ, WEB_CRAWL]);
  expect(
    await tools.web_crawl!.execute!({ url: 'https://1.1.1.1/docs' }, call('denied')),
  ).toMatchObject({ error: 'Tool web.crawl is not enabled for this agent.' });
  expect(
    await tools.web_search!.execute!({ query: 'public documentation' }, call('search')),
  ).toMatchObject({ untrustedResults: [{ rank: 1, excerpt: 'Ranked result.' }] });
  expect(
    await tools.web_read!.execute!({ url: 'https://1.1.1.1/docs' }, call('read')),
  ).toMatchObject({ untrustedResults: [{ content: 'Documentation for a public topic.' }] });
  await tools.web_read!.execute!({ url: 'https://1.1.1.1/docs' }, call('read'));
  expect(requests).toEqual(['POST /v2/search', 'POST /v2/scrape']);
  const evidence = await sql`select tool from web_citations where run_id = ${scope.runId}`;
  expect(evidence.map((row) => row.tool).sort()).toEqual([WEB_READ, WEB_SEARCH]);
});

test('prefers an encrypted agent key and falls back to the environment after removal', async () => {
  const scope = await setup([]);
  process.env.FIRECRAWL_API_KEY = 'test-env-default';
  try {
    expect(await loadFirecrawlConfig(scope.agentId)).toEqual({
      origin: testOrigin,
      key: 'test-env-default',
    });
    expect(
      await sql`select encrypted_key as "encryptedKey" from agent_firecrawl_credentials where agent_id = ${scope.agentId}`,
    ).toHaveLength(0);
    expect(
      await persistFirecrawlCredential(actor, scope.agentId, 'test-agent-override'),
    ).toMatchObject({ message: 'Agent key saved.' });
    const [stored] =
      await sql`select encrypted_key as "encryptedKey" from agent_firecrawl_credentials where agent_id = ${scope.agentId}`;
    expect(stored.encryptedKey).toMatch(/^v1:/);
    expect(stored.encryptedKey).not.toContain('test-agent-override');
    expect((await loadFirecrawlConfig(scope.agentId)).key).toBe('test-agent-override');
    await persistFirecrawlCredential(actor, scope.agentId, null);
    expect((await loadFirecrawlConfig(scope.agentId)).key).toBe('test-env-default');
  } finally {
    process.env.FIRECRAWL_API_KEY = '';
  }
});

test('resumes after worker lease loss and saves only in-scope citations', async () => {
  const scope = await setup([WEB_CRAWL]);
  const requests: string[] = [];
  const provider = mockProvider(requests, 'complete');
  const crawl = toolsFor(scope, provider, [WEB_CRAWL]).web_crawl!;
  expect(await crawl.execute!({ url: 'https://1.1.1.1/docsite' }, call('outside'))).toMatchObject({
    error: 'The crawl URL is outside this agent’s approved scope.',
  });
  const params = { url: 'https://1.1.1.1/docs', pageLimit: 2, depthLimit: 1 };
  const queued = await crawl.execute!(params, call('crawl'));
  expect(queued).toMatchObject({ status: 'queued' });
  expect(await crawl.execute!(params, call('crawl'))).toEqual(queued);
  expect(await crawl.execute!(params, call('second'))).toMatchObject({
    error: 'This agent already has an active crawl.',
  });
  const [initial] = await claimJobs({ workerId: 'worker-before-crash', types: [WEB_CRAWL_JOB] });
  await processWebCrawl(initial, 'worker-before-crash', signal, provider);
  expect(await crawlFor(scope.runId)).toMatchObject({
    providerJobId: 'local-job',
    status: 'running',
  });
  await sql`update jobs set claim_expires_at = now() - interval '1 second' where id = ${initial.id}`;
  await recoverExpiredLeases();
  await work('worker-after-restart', provider);
  await work('worker-after-restart', provider);
  expect(requests).toEqual([
    'POST /v2/crawl',
    'GET /v2/crawl/local-job',
    'GET /v2/crawl/local-job?skip=1',
  ]);
  expect(await crawlFor(scope.runId)).toMatchObject({ status: 'completed' });
  const evidence = await sql`select url from web_citations where run_id = ${scope.runId}`;
  expect(evidence.map(({ url }) => url)).toEqual(['https://1.1.1.1/docs/guide']);
});

test('records a lost provider job and confirms provider cancellation after grant revocation', async () => {
  const lost = await setup([WEB_CRAWL]);
  const provider = mockProvider([], 'lose');
  await toolsFor(lost, provider, [WEB_CRAWL]).web_crawl!.execute!(
    { url: 'https://1.1.1.1/docs' },
    call('lost'),
  );
  await work('lost-worker', provider);
  await work('lost-worker', provider);
  expect(await crawlFor(lost.runId)).toMatchObject({
    status: 'failed',
    reason: expect.stringContaining('missing or expired'),
  });

  const scope = await setup([WEB_CRAWL]);
  const requests: string[] = [];
  const cancelProvider = mockProvider(requests, 'cancel');
  await toolsFor(scope, cancelProvider, [WEB_CRAWL]).web_crawl!.execute!(
    { url: 'https://1.1.1.1/docs' },
    call('cancel'),
  );
  await work('cancel-worker', cancelProvider);
  await persistWebResearchAccess(actor, scope.agentId, [], []);
  await work('cancel-worker', cancelProvider);
  await work('cancel-worker', cancelProvider);
  expect(requests).toEqual([
    'POST /v2/crawl',
    'DELETE /v2/crawl/local-job',
    'GET /v2/crawl/local-job',
  ]);
  const cancelled = await crawlFor(scope.runId);
  expect(cancelled.status).toBe('cancelled');
  expect(await cancelWebCrawl(actor, lost.agentId, cancelled.id)).toEqual({
    error: 'Crawl not found.',
  });
});

test('reserves daily page capacity before dispatch and leaves excess crawls unqueued', async () => {
  const scope = await setup([WEB_CRAWL]);
  const provider = mockProvider([], 'complete');
  const execute = toolsFor(scope, provider, [WEB_CRAWL]).web_crawl!.execute!;
  const params = { url: 'https://1.1.1.1/docs', pageLimit: 25, depthLimit: 3 };
  for (let index = 0; index < 4; index += 1) {
    expect(await execute(params, call('daily-' + index))).toMatchObject({ status: 'queued' });
    await work('quota-worker', provider);
    await work('quota-worker', provider);
    await work('quota-worker', provider);
  }
  expect(await execute(params, call('over-quota'))).toMatchObject({
    error: 'This agent reached its daily crawl page limit.',
  });
  const [row] =
    await sql`select count(*)::int as count from web_crawls where run_id = ${scope.runId}`;
  expect(row.count).toBe(4);
});

test('records unavailable when the endpoint has no crawl operation', async () => {
  const scope = await setup([WEB_CRAWL]);
  const unsupported = (() =>
    Promise.resolve(
      Response.json({ code: 'CLOUD_ONLY' }, { status: 501 }),
    )) as unknown as typeof fetch;
  await toolsFor(scope, unsupported, [WEB_CRAWL]).web_crawl!.execute!(
    { url: 'https://1.1.1.1/docs' },
    call('unsupported'),
  );
  await work('unsupported-worker', unsupported);
  expect(await crawlFor(scope.runId)).toMatchObject({
    status: 'unavailable',
    reason: 'The configured Firecrawl endpoint does not support this operation.',
  });
});

test('the normal simulation entry point exposes only granted web tools and persists their evidence', async () => {
  const scope = await setup([WEB_SEARCH, WEB_READ]);
  await sql`update simulation_runs set status = 'completed', finished_at = now() where id = ${scope.runId}`;
  await sql`update agents set budgets = ${sql.json({
    ...budgetDefaults,
    dailySpendCents: null,
    monthlySpendCents: null,
  })} where id = ${scope.agentId}`;
  const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = 'simulation-provider-test-key';
  const requests: string[] = [];
  globalThis.fetch = mockProvider(requests, 'complete');
  try {
    const simulation = await executeSimulation(
      {
        actor,
        agentId: scope.agentId,
        configurationId: scope.configId,
        input: 'Find public documentation.',
      },
      () => async (request) => {
        if (request.stage === 'main') {
          expect(Object.keys(request.tools ?? {}).sort()).toEqual(['web_read', 'web_search']);
          await request.tools!.web_search.execute!(
            { query: 'public documentation' },
            call('main-search'),
          );
        }
        return {
          decision: {
            relevant: true,
            priority: 1,
            reason: 'Find documentation',
            actions: [],
            ...(request.stage === 'main'
              ? { answer: 'Documentation found.', citations: [], memoryCitations: [] }
              : {}),
          },
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    );
    expect(requests).toEqual(['POST /v2/search']);
    const [run] = await sql`select status from simulation_runs where id = ${simulation.runId!}`;
    expect(run.status).toBe('completed');
    const evidence = await sql`select tool from web_citations where run_id = ${simulation.runId!}`;
    expect(evidence.map(({ tool }) => tool)).toEqual([WEB_SEARCH]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
  }
});

test('caps distinct crawl citations across repeated and reordered provider polls', async () => {
  const scope = await setup([WEB_CRAWL]);
  const snapshots = [
    ['first', 'first'],
    ['second', 'first'],
    ['third', 'fourth'],
  ];
  const provider = ((_: URL, init: RequestInit) => {
    if (init.method === 'POST') return Promise.resolve(Response.json({ id: 'changing-job' }));
    const names = snapshots.shift()!;
    return Promise.resolve(
      Response.json({
        status: snapshots.length ? 'scraping' : 'completed',
        completed: 2,
        total: 2,
        data: names.map((name) => ({
          markdown: 'A public document.',
          metadata: { url: 'https://1.1.1.1/docs/' + name },
        })),
      }),
    );
  }) as typeof fetch;

  await toolsFor(scope, provider, [WEB_CRAWL]).web_crawl!.execute!(
    { url: 'https://1.1.1.1/docs', pageLimit: 2 },
    call('changing-pages'),
  );
  await work('changing-worker', provider);
  for (let poll = 0; poll < 3; poll += 1) {
    await sql`update jobs set available_at = now() where payload->>'agentId' = ${scope.agentId}`;
    await work('changing-worker', provider);
  }
  expect(await crawlFor(scope.runId)).toMatchObject({ status: 'completed' });
  const evidence =
    await sql`select url from web_citations where run_id = ${scope.runId} order by url`;
  expect(evidence.map(({ url }) => url)).toEqual([
    'https://1.1.1.1/docs/first',
    'https://1.1.1.1/docs/second',
  ]);
});
