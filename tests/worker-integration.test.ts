import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import postgres from 'postgres';

import { budgetDefaults, BudgetError, budgetViolationMessage } from '@/lib/budgets';
import { cancelWorkForLifecycle } from '@/lib/lifecycle-work';
import { authorizeAction, loadPolicyContext, reserveRequestQuota } from '@/lib/policy/gateway';
import {
  enqueueSimulation,
  finalizeExhaustedSimulationJob,
  finalizeOrphanedDeadSimulationRuns,
  processSimulationJob,
  SIMULATION_JOB_TYPE,
} from '@/lib/runtime/execute';
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

test('reserveRequestQuota serializes concurrent reservations under the hard cap', async () => {
  const id = randomUUID();
  ids.push(id);
  const budgets = { ...budgetDefaults, dailyRequests: 1, monthlyRequests: 1 };
  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (${id},'QuotaRace','Mission','shadow',${sql.json(budgets)},${sql.json([])})
  `;
  const results = await Promise.allSettled([reserveRequestQuota(id), reserveRequestQuota(id)]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BudgetError);
  expect(((rejected[0] as PromiseRejectedResult).reason as BudgetError).message).toBe(
    budgetViolationMessage('daily-requests'),
  );
  const [day] =
    await sql`SELECT requests FROM usage_counters WHERE agent_id=${id} AND period='day'`;
  expect(day.requests).toBe(1);
});

test('stale execution tokens cannot overwrite a reclaimed run', async () => {
  const id = randomUUID();
  ids.push(id);
  const [preset] = await sql`SELECT config FROM templates WHERE id='support'`;
  const config = { ...preset.config, name: 'TokenFence' };
  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (${id},'TokenFence',${config.mission},'shadow',${sql.json(budgetDefaults)},${sql.json([])})
  `;
  const [version] =
    await sql`INSERT INTO agent_configurations(agent_id,version,config,actor) VALUES (${id},1,${sql.json(config)},'test') RETURNING id`;
  await sql`INSERT INTO agent_credentials VALUES (${id},${encryptCredential(id, 'secret-token')})`;
  await sql`UPDATE controls SET paused=false`;

  const queued = await enqueueSimulation({
    actor: 'test@example.com',
    agentId: id,
    configurationId: version.id,
    input: 'Token fence prompt',
  });
  expect('runId' in queued && queued.runId).toBeTruthy();
  const runId = queued.runId!;

  let firstGate!: { continue: () => void };
  const firstHold = new Promise<void>((resolve) => {
    firstGate = { continue: resolve };
  });
  let firstCalls = 0;

  const first = processSimulationJob({ runId, agentId: id }, () => async () => {
    firstCalls += 1;
    if (firstCalls === 1) await firstHold;
    return {
      decision: {
        relevant: true,
        priority: 0.5,
        reason: 'stale',
        actions: [{ type: 'reply', reason: 'stale', draft: 'stale draft' }],
      },
      inputTokens: 1,
      outputTokens: 1,
    };
  });

  // Wait until the first claim has marked the run running with a token.
  for (let i = 0; i < 50; i++) {
    const [row] = await sql`SELECT status, execution_token FROM simulation_runs WHERE id=${runId}`;
    if (row.status === 'running' && row.execution_token) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const [before] = await sql`SELECT execution_token FROM simulation_runs WHERE id=${runId}`;
  expect(before.execution_token).toBeTruthy();

  // Second claim rotates the execution token while the first is still in inference.
  await processSimulationJob({ runId, agentId: id }, () => async () => ({
    decision: {
      relevant: true,
      priority: 0.9,
      reason: 'replacement',
      actions: [{ type: 'reply', reason: 'ok', draft: 'replacement draft' }],
    },
    inputTokens: 2,
    outputTokens: 2,
  }));

  const [afterSecond] =
    await sql`SELECT status, result, execution_token FROM simulation_runs WHERE id=${runId}`;
  expect(afterSecond.status).toBe('completed');
  expect(afterSecond.result.actions[0].draft).toBe('replacement draft');
  expect(afterSecond.execution_token).not.toBe(before.execution_token);

  firstGate.continue();
  await first;
  // Lost ownership must cancel before a second paid model stage or policy writes.
  expect(firstCalls).toBe(1);
  const [final] = await sql`SELECT status, result FROM simulation_runs WHERE id=${runId}`;
  expect(final.status).toBe('completed');
  expect(final.result.actions[0].draft).toBe('replacement draft');
});

test('retries preserve the original run deadline', async () => {
  const id = randomUUID();
  ids.push(id);
  const [preset] = await sql`SELECT config FROM templates WHERE id='support'`;
  const budgets = { ...budgetDefaults, runDeadlineSeconds: 30 };
  const config = { ...preset.config, name: 'DeadlineRetry' };
  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (${id},'DeadlineRetry',${config.mission},'shadow',${sql.json(budgets)},${sql.json([])})
  `;
  const [version] =
    await sql`INSERT INTO agent_configurations(agent_id,version,config,actor) VALUES (${id},1,${sql.json(config)},'test') RETURNING id`;
  await sql`INSERT INTO agent_credentials VALUES (${id},${encryptCredential(id, 'secret-deadline')})`;
  await sql`UPDATE controls SET paused=false`;

  const queued = await enqueueSimulation({
    actor: 'test@example.com',
    agentId: id,
    configurationId: version.id,
    input: 'Deadline retry prompt',
  });
  expect('runId' in queued && queued.runId).toBeTruthy();
  const runId = queued.runId!;

  const { RetryableInfrastructureError } = await import('@/lib/runtime/errors');
  await expect(
    processSimulationJob({ runId, agentId: id }, () => async () => {
      throw new RetryableInfrastructureError('policy store blip');
    }),
  ).rejects.toBeInstanceOf(RetryableInfrastructureError);

  const [afterFirst] = await sql`SELECT status, expires_at FROM simulation_runs WHERE id=${runId}`;
  expect(afterFirst.status).toBe('running');
  const firstExpiry = new Date(afterFirst.expires_at).getTime();

  await processSimulationJob({ runId, agentId: id }, () => async () => ({
    decision: {
      relevant: false,
      priority: 0,
      reason: 'done',
      actions: [],
    },
    inputTokens: 1,
    outputTokens: 1,
  }));

  const [afterSecond] = await sql`SELECT status, expires_at FROM simulation_runs WHERE id=${runId}`;
  expect(afterSecond.status).toBe('completed');
  expect(new Date(afterSecond.expires_at).getTime()).toBe(firstExpiry);
});

test('finalizeExhaustedSimulationJob clears running runs after dead-letter', async () => {
  const id = randomUUID();
  ids.push(id);
  const [preset] = await sql`SELECT config FROM templates WHERE id='support'`;
  const config = { ...preset.config, name: 'DeadLetter' };
  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (${id},'DeadLetter',${config.mission},'shadow',${sql.json(budgetDefaults)},${sql.json([])})
  `;
  const [version] =
    await sql`INSERT INTO agent_configurations(agent_id,version,config,actor) VALUES (${id},1,${sql.json(config)},'test') RETURNING id`;
  const [run] = await sql`
    INSERT INTO simulation_runs(agent_id,configuration_id,input,status,result,actor,expires_at,execution_token)
    VALUES (
      ${id},
      ${version.id},
      'stuck',
      'running',
      ${sql.json({ steps: [], actions: [], error: null })},
      'test',
      now() + interval '1 hour',
      ${randomUUID()}
    )
    RETURNING id
  `;
  await finalizeExhaustedSimulationJob({ runId: run.id }, 'quota reservation db blip');
  const [done] =
    await sql`SELECT status, defer_reason, result FROM simulation_runs WHERE id=${run.id}`;
  expect(done.status).toBe('failed');
  expect(done.defer_reason).toContain('retries exhausted');
  expect(done.result.error).toContain('retries exhausted');
});

test('pause interrupts retry-waiting runs linked to cancelled pending jobs', async () => {
  const id = randomUUID();
  ids.push(id);
  const [preset] = await sql`SELECT config FROM templates WHERE id='support'`;
  const config = { ...preset.config, name: 'PauseRetry' };
  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (${id},'PauseRetry',${config.mission},'shadow',${sql.json(budgetDefaults)},${sql.json([])})
  `;
  const [version] =
    await sql`INSERT INTO agent_configurations(agent_id,version,config,actor) VALUES (${id},1,${sql.json(config)},'test') RETURNING id`;
  const [job] = await sql`
    INSERT INTO jobs(type,payload,status,attempts,max_attempts,available_at)
    VALUES (
      ${SIMULATION_JOB_TYPE},
      ${sql.json({ runId: 'pending', agentId: id })},
      'pending',
      1,
      3,
      now()
    )
    RETURNING id
  `;
  const [run] = await sql`
    INSERT INTO simulation_runs(agent_id,configuration_id,input,status,result,actor,expires_at,execution_token,job_id)
    VALUES (
      ${id},
      ${version.id},
      'retry-waiting',
      'running',
      ${sql.json({ steps: [], actions: [], error: null })},
      'test',
      now() + interval '1 hour',
      ${randomUUID()},
      ${job.id}
    )
    RETURNING id
  `;
  await sql`UPDATE jobs SET payload = ${sql.json({ runId: run.id, agentId: id })} WHERE id = ${job.id}`;

  // Claimed in-flight run should survive pause.
  const [claimedJob] = await sql`
    INSERT INTO jobs(type,payload,status,attempts,max_attempts,available_at,claimed_by,claimed_at,claim_expires_at)
    VALUES (
      ${SIMULATION_JOB_TYPE},
      ${sql.json({ runId: 'claimed', agentId: id })},
      'claimed',
      1,
      3,
      now(),
      'worker-active',
      now(),
      now() + interval '1 hour'
    )
    RETURNING id
  `;
  const [activeRun] = await sql`
    INSERT INTO simulation_runs(agent_id,configuration_id,input,status,result,actor,expires_at,execution_token,job_id)
    VALUES (
      ${id},
      ${version.id},
      'active-claim',
      'running',
      ${sql.json({ steps: [], actions: [], error: null })},
      'test',
      now() + interval '1 hour',
      ${randomUUID()},
      ${claimedJob.id}
    )
    RETURNING id
  `;

  await sql`UPDATE agents SET lifecycle='paused' WHERE id=${id}`;
  const cancelled = await cancelWorkForLifecycle(id, 'paused');
  expect(cancelled).toEqual([job.id]);

  const [retryWaiting] =
    await sql`SELECT status, defer_reason FROM simulation_runs WHERE id=${run.id}`;
  const [stillActive] = await sql`SELECT status FROM simulation_runs WHERE id=${activeRun.id}`;
  const [cancelledJob] = await sql`SELECT status FROM jobs WHERE id=${job.id}`;
  const [keptClaim] = await sql`SELECT status FROM jobs WHERE id=${claimedJob.id}`;
  expect(retryWaiting.status).toBe('interrupted');
  expect(retryWaiting.defer_reason).toContain('paused');
  expect(stillActive.status).toBe('running');
  expect(cancelledJob.status).toBe('cancelled');
  expect(keptClaim.status).toBe('claimed');
});

test('finalizeOrphanedDeadSimulationRuns clears runs linked to dead jobs', async () => {
  const id = randomUUID();
  ids.push(id);
  const [preset] = await sql`SELECT config FROM templates WHERE id='support'`;
  const config = { ...preset.config, name: 'OrphanDead' };
  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (${id},'OrphanDead',${config.mission},'shadow',${sql.json(budgetDefaults)},${sql.json([])})
  `;
  const [version] =
    await sql`INSERT INTO agent_configurations(agent_id,version,config,actor) VALUES (${id},1,${sql.json(config)},'test') RETURNING id`;
  const [job] = await sql`
    INSERT INTO jobs(type,payload,status,attempts,max_attempts,available_at,finished_at,last_error)
    VALUES (
      ${SIMULATION_JOB_TYPE},
      ${sql.json({ runId: 'pending' })},
      'dead',
      5,
      5,
      now(),
      now(),
      'quota reservation db blip'
    )
    RETURNING id
  `;
  const [run] = await sql`
    INSERT INTO simulation_runs(agent_id,configuration_id,input,status,result,actor,expires_at,execution_token,job_id)
    VALUES (
      ${id},
      ${version.id},
      'orphan',
      'running',
      ${sql.json({ steps: [], actions: [], error: null })},
      'test',
      now() + interval '1 hour',
      ${randomUUID()},
      ${job.id}
    )
    RETURNING id
  `;
  await sql`UPDATE jobs SET payload = ${sql.json({ runId: run.id })} WHERE id = ${job.id}`;
  await finalizeOrphanedDeadSimulationRuns();
  const [done] =
    await sql`SELECT status, defer_reason, result FROM simulation_runs WHERE id=${run.id}`;
  expect(done.status).toBe('failed');
  expect(done.defer_reason).toContain('retries exhausted');
  expect(done.result.error).toContain('reconciled');
});
