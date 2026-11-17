import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import postgres from 'postgres';

import { executeSimulation } from '@/lib/runtime/execute';
import { encryptCredential } from '@/lib/runtime/secrets';

// Disposable PostgreSQL database only. Inference is deliberately mocked, never a live API call.
const databaseUrl = 'postgres://orbit:orbit_dev@localhost:5432/orbit_test';
process.env.DATABASE_URL = databaseUrl;
process.env.APP_URL = 'http://localhost:3000';
process.env.AUTH_DISABLED = 'false';
process.env.ORBIT_ADMIN_EMAIL = 'admin@example.com';
process.env.ORBIT_ADMIN_PASSWORD = 'test-only-password-123456';
process.env.ORBIT_ENCRYPTION_KEY = 'a'.repeat(64);
const sql = postgres(databaseUrl);
const ids: string[] = [];
afterAll(async () => {
  for (const id of ids) {
    await sql`DELETE FROM simulation_runs WHERE agent_id=${id}`;
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
    await sql`INSERT INTO agents(id,name,mission) VALUES (${id},${name},${config.mission})`;
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
    expect(mismatch.error).toBeDefined();
  } finally {
    await freshConnection.end();
  }
});
test('missing keys, interruption recovery and concurrent claims are durable', async () => {
  const id = randomUUID();
  ids.push(id);
  await sql`INSERT INTO agents(id,name,mission) VALUES (${id},'Test','Test')`;
  const [v] =
    await sql`INSERT INTO agent_configurations(agent_id,version,config,actor) SELECT ${id},1,config,'test' FROM templates WHERE id='support' RETURNING id`;
  const params = { agentId: id, configurationId: v.id, actor: 'test', input: 'Question' };
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
    expect((await executeSimulation(params)).error).toContain('already in progress');
  } finally {
    release();
    await first;
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
