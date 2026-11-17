import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import postgres from 'postgres';

import { budgetDefaults } from '@/lib/budgets';
import { authorizeAction, loadPolicyContext } from '@/lib/policy/gateway';
import { enqueueSimulation, processSimulationJob } from '@/lib/runtime/execute';
import { encryptCredential } from '@/lib/runtime/secrets';

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
    await sql`DELETE FROM policy_decisions WHERE agent_id=${id}`;
    await sql`DELETE FROM action_intents WHERE agent_id=${id}`;
    await sql`DELETE FROM usage_counters WHERE agent_id=${id}`;
    await sql`DELETE FROM simulation_runs WHERE agent_id=${id}`;
    await sql`DELETE FROM jobs WHERE payload->>'agentId'=${id}`;
    await sql`DELETE FROM agent_credentials WHERE agent_id=${id}`;
    await sql`DELETE FROM agent_configurations WHERE agent_id=${id}`;
    await sql`DELETE FROM agents WHERE id=${id}`;
  }
  await sql.end();
});

test('web enqueue and worker process complete a simulation end to end', async () => {
  const id = randomUUID();
  ids.push(id);
  const [preset] = await sql`SELECT config FROM templates WHERE id='support'`;
  const config = { ...preset.config, name: 'Integration' };
  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (${id},'Integration',${config.mission},'shadow',${sql.json(budgetDefaults)},${sql.json([])})
  `;
  const [version] =
    await sql`INSERT INTO agent_configurations(agent_id,version,config,actor) VALUES (${id},1,${sql.json(config)},'test') RETURNING id`;
  await sql`INSERT INTO agent_credentials VALUES (${id},${encryptCredential(id, 'secret-integration')})`;
  // Release the global pause so this case exercises suppress-without-adapters, not deny-on-pause.
  await sql`UPDATE controls SET paused=false`;

  const queued = await enqueueSimulation({
    actor: 'test@example.com',
    agentId: id,
    configurationId: version.id,
    input: 'How do I reset my password?',
  });
  expect('runId' in queued && queued.runId).toBeTruthy();
  const [run] = await sql`SELECT * FROM simulation_runs WHERE id=${queued.runId!}`;
  expect(run.status).toBe('queued');
  expect(run.job_id).toBeTruthy();

  await processSimulationJob({ runId: queued.runId!, agentId: id }, () => async () => ({
    decision: {
      relevant: true,
      priority: 0.9,
      reason: 'support question',
      actions: [{ type: 'reply', reason: 'help', draft: 'Here is how…' }],
    },
    inputTokens: 11,
    outputTokens: 7,
  }));
  await sql`UPDATE jobs SET status='completed', finished_at=now(), updated_at=now() WHERE id=${queued.jobId!}`;

  const [done] = await sql`SELECT * FROM simulation_runs WHERE id=${queued.runId!}`;
  expect(done.status).toBe('completed');
  expect(done.result.actions[0].policy).toBe('suppressed');
  const intents = await sql`SELECT * FROM action_intents WHERE agent_id=${id}`;
  expect(intents.length).toBeGreaterThan(0);
  const decisions = await sql`SELECT * FROM policy_decisions WHERE agent_id=${id}`;
  expect(decisions.length).toBeGreaterThan(0);
});

test('policy gateway persists deny for global pause', async () => {
  const id = randomUUID();
  ids.push(id);
  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (${id},'PausedGate','Mission','shadow',${sql.json(budgetDefaults)},${sql.json([])})
  `;
  await sql`UPDATE controls SET paused=true`;
  const ctx = await loadPolicyContext(id, 'admin@example.com');
  expect(ctx).not.toBeNull();
  const result = await authorizeAction(ctx!, {
    type: 'reply',
    idempotencyKey: `pause-${id}`,
  });
  expect(result.decision).toBe('deny');
  const [intent] = await sql`SELECT * FROM action_intents WHERE idempotency_key=${`pause-${id}`}`;
  expect(intent.decision).toBe('deny');
});
