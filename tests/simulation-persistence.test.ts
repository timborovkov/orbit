import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import postgres from 'postgres';

import { budgetDefaults } from '@/lib/budgets';
import { executeSimulation } from '@/lib/runtime/execute';
import { encryptCredential } from '@/lib/runtime/secrets';
import type { ModelCall } from '@/lib/runtime/simulation';

// Disposable PostgreSQL database only. Inference is deliberately mocked, never a live API call.
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://orbit:orbit_dev@localhost:5432/orbit_test';
process.env.DATABASE_URL = databaseUrl;
process.env.APP_URL = 'http://localhost:3000';
process.env.AUTH_DISABLED = 'false';
process.env.ORBIT_ADMIN_EMAIL = 'admin@example.com';
process.env.ORBIT_ADMIN_PASSWORD = 'test-only-password-123456';
process.env.ORBIT_ENCRYPTION_KEY = 'a'.repeat(64);
const sql = postgres(databaseUrl);
const ids: string[] = [];
const uncapped = { ...budgetDefaults, dailySpendCents: null, monthlySpendCents: null };
afterAll(async () => {
  for (const id of ids) {
    await sql`DELETE FROM policy_decisions WHERE agent_id=${id}`;
    await sql`DELETE FROM action_intents WHERE agent_id=${id}`;
    await sql`DELETE FROM usage_counters WHERE agent_id=${id}`;
    await sql`DELETE FROM evaluation_comparisons WHERE agent_id=${id}`;
    await sql`DELETE FROM evaluation_cases WHERE agent_id=${id}`;
    await sql`DELETE FROM simulation_runs WHERE agent_id=${id}`;
    await sql`DELETE FROM jobs WHERE payload->>'agentId'=${id}`;
    await sql`DELETE FROM agent_credentials WHERE agent_id=${id}`;
    await sql`DELETE FROM agent_configurations WHERE agent_id=${id}`;
    await sql`DELETE FROM agents WHERE id=${id}`;
  }
  await sql.end();
});
test('John and Sarah persist independent snapshots and distinct results across new connections', async () => {
  const input = 'I need help choosing the right product and resolving my setup problem.';
  const configurations: string[] = [];
  for (const [name, template] of [
    ['John', 'sales'],
    ['Sarah', 'support'],
  ]) {
    const id = randomUUID();
    ids.push(id);
    const [preset] = await sql`SELECT config FROM templates WHERE id=${template}`;
    const config = { ...preset.config, name, personality: `${name}'s independent voice` };
    await sql`INSERT INTO agents(id,name,mission,budgets) VALUES (${id},${name},${config.mission},${sql.json(uncapped)})`;
    const [version] =
      await sql`INSERT INTO agent_configurations(agent_id,version,config,actor) VALUES (${id},1,${sql.json(config)},'test') RETURNING id`;
    configurations.push(version.id);
    await sql`INSERT INTO agent_credentials VALUES (${id},${encryptCredential(id, `secret-${name}`)})`;
    // Execute in a separate Bun process, then stop it before inspecting history.
    // This exercises the same shared runtime a future worker can call.
    const child = Bun.spawn(
      [
        'bun',
        '--eval',
        `
      import { budgetDefaults } from '@/lib/budgets';
import { executeSimulation } from './apps/web/src/lib/runtime/execute';
      const config = ${JSON.stringify(config)};
      const name = ${JSON.stringify(name)};
      const result = await executeSimulation(${JSON.stringify({ agentId: id, configurationId: version.id, actor: 'test', input })}, secret => async request => {
        if (secret !== 'secret-' + name || request.system.includes(secret)) throw new Error('Credential boundary failed');
        return { decision: { relevant: true, priority: 0.8, reason: name + ' evaluated', actions: [{ type: 'reply', reason: config.role, draft: name + ': ' + config.personality }] }, inputTokens: 10, outputTokens: 5 };
      });
      if (result.error) throw new Error(result.error);
      process.exit(0);
    `,
      ],
      { env: { ...process.env, DATABASE_URL: databaseUrl }, stdout: 'pipe', stderr: 'pipe' },
    );
    const exit = await child.exited;
    expect(exit, await new Response(child.stderr).text()).toBe(0);
    // Later revisions must not alter historical run/config binding.
    await sql`INSERT INTO agent_configurations(agent_id,version,config,actor) VALUES (${id},2,${sql.json({ ...config, personality: 'Changed after run' })},'test')`;
  }
  const freshConnection = postgres(databaseUrl);
  try {
    const records =
      await freshConnection`SELECT r.*, c.version, c.config FROM simulation_runs r JOIN agent_configurations c ON c.id=r.configuration_id WHERE r.agent_id IN ${sql(ids)} ORDER BY c.config->>'name'`;
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.status)).toEqual(['completed', 'completed']);
    expect(records.every((r) => r.input === input && r.version === 1)).toBe(true);
    expect(records[0].result.actions[0].draft).not.toBe(records[1].result.actions[0].draft);
    expect(JSON.stringify(records)).not.toContain('secret-');
    expect(records[0].result.steps).toHaveLength(2);
    const mismatch = await executeSimulation({
      agentId: ids[0],
      configurationId: configurations[1],
      actor: 'test',
      input,
    });
    expect('error' in mismatch).toBe(true);
  } finally {
    await freshConnection.end();
  }
});
test('missing keys, interruption recovery and concurrent claims are durable', async () => {
  const id = randomUUID();
  ids.push(id);
  await sql`INSERT INTO agents(id,name,mission,budgets) VALUES (${id},'Test','Test',${sql.json(uncapped)})`;
  const [v] =
    await sql`INSERT INTO agent_configurations(agent_id,version,config,actor) SELECT ${id},1,config,'test' FROM templates WHERE id='support' RETURNING id`;
  const params = { agentId: id, configurationId: v.id, actor: 'test', input: 'Question' };
  delete process.env.OPENROUTER_API_KEY;
  await executeSimulation(params);
  const [failure] = await sql`SELECT * FROM simulation_runs WHERE agent_id=${id}`;
  expect(failure.status).toBe('failed');
  await sql`INSERT INTO simulation_runs(agent_id,configuration_id,input,result,actor,expires_at) VALUES (${id},${v.id},'interrupted',${sql.json({ steps: [], actions: [], error: null })},'test',now()-interval '1 minute')`;
  await executeSimulation(params);
  const [interrupted] =
    await sql`SELECT * FROM simulation_runs WHERE agent_id=${id} AND input='interrupted'`;
  expect(interrupted.status).toBe('interrupted');
  await sql`INSERT INTO agent_credentials VALUES (${id},${encryptCredential(id, 'secret')})`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = executeSimulation(params, () => async () => {
    entered();
    await gate;
    return {
      decision: { relevant: false, priority: 0, reason: 'skip', actions: [] },
      inputTokens: 0,
      outputTokens: 0,
    };
  });
  await started;
  try {
    const blocked = await executeSimulation(params);
    expect('error' in blocked && blocked.error).toContain('concurrency limit');
  } finally {
    release();
    await first;
  }
});

test('environment OpenRouter default works without encryption or an agent credential', async () => {
  const id = randomUUID();
  ids.push(id);
  await sql`INSERT INTO agents(id,name,mission,budgets) VALUES (${id},'EnvDefault','Use env key',${sql.json(uncapped)})`;
  const [v] =
    await sql`INSERT INTO agent_configurations(agent_id,version,config,actor) SELECT ${id},1,config,'test' FROM templates WHERE id='blank' RETURNING id`;
  const previousEncryption = process.env.ORBIT_ENCRYPTION_KEY;
  const previousOpenRouter = process.env.OPENROUTER_API_KEY;
  delete process.env.ORBIT_ENCRYPTION_KEY;
  process.env.OPENROUTER_API_KEY = 'env-default-simulation-secret';
  try {
    const result = await executeSimulation(
      { agentId: id, configurationId: v.id, actor: 'test', input: 'Hello from env default' },
      (secret) => async () => {
        if (secret !== 'env-default-simulation-secret') throw new Error('Expected env key');
        return {
          decision: { relevant: false, priority: 0, reason: 'skip', actions: [] },
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    );
    expect('error' in result).toBe(false);
    const [run] = await sql`SELECT status, result FROM simulation_runs WHERE agent_id=${id}`;
    expect(run.status).toBe('completed');
    expect(JSON.stringify(run)).not.toContain('env-default-simulation-secret');
  } finally {
    if (previousEncryption) process.env.ORBIT_ENCRYPTION_KEY = previousEncryption;
    else delete process.env.ORBIT_ENCRYPTION_KEY;
    if (previousOpenRouter) process.env.OPENROUTER_API_KEY = previousOpenRouter;
    else delete process.env.OPENROUTER_API_KEY;
  }
});

test('DeepSeek defaults migration preserves customized models and saved agent versions', async () => {
  const { readFile } = await import('node:fs/promises');
  const migration = await readFile('apps/web/drizzle/0002_deepseek_defaults.sql', 'utf8');
  const rollback = new Error('Rollback migration verification');
  try {
    await sql.begin(async (tx) => {
      const id = `test-${randomUUID()}`;
      await tx`INSERT INTO templates (id,title,config) VALUES (${id},'Migration test',${tx.json({ mainModel: 'custom/main', evaluatorModel: 'openai/gpt-4.1-nano' })})`;
      const before = await tx`SELECT id,config FROM agent_configurations ORDER BY id`;
      await tx.unsafe(migration);
      const [updated] = await tx`SELECT config,revision FROM templates WHERE id=${id}`;
      expect(updated.config.mainModel).toBe('custom/main');
      expect(updated.config.evaluatorModel).toBe('deepseek/deepseek-v4.1-flash-1017');
      expect(updated.revision).toBe(2);
      expect(await tx`SELECT id,config FROM agent_configurations ORDER BY id`).toEqual(before);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
});

test('optional retrieval falls back to one provider call while keeping recalled evidence', async () => {
  for (const cap of ['requests', 'spend'] as const) {
    const id = randomUUID();
    ids.push(id);
    const budgets =
      cap === 'requests' ? { ...uncapped, dailyRequests: 2 } : { ...uncapped, dailySpendCents: 1 };
    await sql`INSERT INTO agents(id,name,mission,budgets) VALUES (${id},'Retrieval fixture','Help',${sql.json(budgets)})`;
    const [version] =
      await sql`INSERT INTO agent_configurations(agent_id,version,config,actor) SELECT ${id},1,config,'test' FROM templates WHERE id='support' RETURNING id`;
    await sql`INSERT INTO agent_credentials VALUES (${id},${encryptCredential(id, 'fixture-key')})`;
    const message = 'The SSO deadline for the Northstar pilot is Friday.';
    const [prior] = await sql`INSERT INTO simulation_runs
      (agent_id,configuration_id,input,origin,channel,actor,result,expires_at,status)
      VALUES (${id},${version!.id},${message},'channel','fixture-chat','test','{}',now(),'completed') RETURNING id`;
    const [source] =
      await sql`INSERT INTO source_events (agent_id,provider,provider_event_id,payload,text,run_id)
      VALUES (${id},'fixture-chat','previous','{}',${message},${prior!.id}) RETURNING id`;
    const [memory] =
      await sql`INSERT INTO agent_memories (agent_id,subject_kind,subject,topic,identity_key,fact,quote,run_id,source_kind,source_id,source_at)
      VALUES (${id},'project','Northstar pilot','SSO deadline','fixture',${message},${message},${prior!.id},'event',${source!.id},now()) RETURNING id, revision`;
    const stages: string[] = [];
    const toolPricing: boolean[] = [];
    const result = await executeSimulation(
      {
        actor: 'test',
        agentId: id,
        configurationId: version!.id,
        input: 'What is the SSO deadline for the Northstar pilot?',
      },
      () =>
        Object.assign(
          async (request: Parameters<ModelCall>[0]) => {
            stages.push(request.stage!);
            expect(Object.keys(request.tools ?? {})).toEqual([]);
            expect(request.system).not.toContain('Use the retrieval tools available');
            expect(JSON.parse(request.input).untrustedMemories).toMatchObject([{ fact: message }]);
            return {
              decision: {
                relevant: true,
                priority: 1,
                reason: 'Help with the pilot',
                actions: [{ type: 'reply', reason: 'Reply', draft: null }],
                ...(request.stage === 'main'
                  ? { answer: 'Friday.', citations: [], memoryCitations: [1] }
                  : {}),
              },
              inputTokens: 1,
              outputTokens: 1,
              costMicros: 2_000,
            };
          },
          {
            quote: async (
              _model: string,
              _signal: AbortSignal,
              options?: { requireTools?: boolean },
            ) => {
              toolPricing.push(Boolean(options?.requireTools));
              return {
                endpoint: 'fixture',
                upperBoundMicros: 6_000,
                maxPrice: { prompt: 1, completion: 1, request: 0 },
              };
            },
          },
        ),
    );
    expect(stages).toEqual(['evaluator', 'main']);
    expect(toolPricing).toEqual(cap === 'spend' ? [false, true, false] : []);
    if (!result.runId) throw new Error(result.error);
    const [run] = await sql`SELECT status,result FROM simulation_runs WHERE id=${result.runId}`;
    expect(run).toMatchObject({
      status: 'completed',
      result: {
        memory: [memory!],
        steps: [
          { stage: 'evaluator' },
          { stage: 'main', decision: { answer: 'Friday.', memoryCitations: [1] } },
        ],
      },
    });
    const [day] =
      await sql`SELECT requests,spend_micros FROM usage_counters WHERE agent_id=${id} AND period='day'`;
    expect(day).toMatchObject({ requests: 2, spend_micros: '4000' });
  }
});
