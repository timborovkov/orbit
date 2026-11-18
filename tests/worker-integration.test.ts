import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import postgres from 'postgres';

import { budgetDefaults, BudgetError, budgetViolationMessage } from '@/lib/budgets';
import { cancelWorkForLifecycle } from '@/lib/lifecycle-work';
import { authorizeAction, loadPolicyContext, reserveRequestQuota } from '@/lib/policy/gateway';
import {
  enqueueSimulation,
  finalizeExhaustedSimulationJob,
  finalizeOrphanedCompletedSimulationRuns,
  finalizeOrphanedDeadSimulationRuns,
  processSimulationJob,
  SIMULATION_JOB_TYPE,
} from '@/lib/runtime/execute';
import { encryptCredential } from '@/lib/runtime/secrets';
import { recordConsent, reviewProposedAction } from '@/lib/server/policy-mutations';

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
    VALUES (${id},'Integration',${config.mission},'shadow',${sql.json(uncapped)},${sql.json([])})
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
    VALUES (${id},'PausedGate','Mission','shadow',${sql.json(uncapped)},${sql.json([])})
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

test('paused agents cannot enqueue simulations and workers skip model calls', async () => {
  const id = randomUUID();
  ids.push(id);
  const [preset] = await sql`SELECT config FROM templates WHERE id='support'`;
  const config = { ...preset.config, name: 'PausedGate' };
  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (${id},'PausedGate',${config.mission},'paused',${sql.json(uncapped)},${sql.json([])})
  `;
  const [version] =
    await sql`INSERT INTO agent_configurations(agent_id,version,config,actor) VALUES (${id},1,${sql.json(config)},'test') RETURNING id`;
  await sql`INSERT INTO agent_credentials VALUES (${id},${encryptCredential(id, 'secret-paused')})`;
  await sql`UPDATE controls SET paused=false`;

  const blocked = await enqueueSimulation({
    actor: 'test@example.com',
    agentId: id,
    configurationId: version.id,
    input: 'Should not queue',
  });
  expect(blocked).toEqual({
    error: 'This agent is paused. Resume it before starting a simulation.',
  });

  // Pre-queued run claimed after pause must fail before inference.
  await sql`UPDATE agents SET lifecycle='shadow' WHERE id=${id}`;
  const queued = await enqueueSimulation({
    actor: 'test@example.com',
    agentId: id,
    configurationId: version.id,
    input: 'Queued then paused',
  });
  expect('runId' in queued && queued.runId).toBeTruthy();
  const runId = queued.runId!;
  await sql`UPDATE agents SET lifecycle='paused' WHERE id=${id}`;

  let calls = 0;
  await processSimulationJob({ runId, agentId: id }, () => async () => {
    calls += 1;
    return {
      decision: { relevant: false, priority: 0, reason: 'no', actions: [] },
      inputTokens: 1,
      outputTokens: 1,
    };
  });
  expect(calls).toBe(0);
  const [done] =
    await sql`SELECT status, defer_reason, result FROM simulation_runs WHERE id=${runId}`;
  expect(done.status).toBe('failed');
  expect(done.defer_reason).toContain('paused');
  expect(done.result.error).toContain('paused');
});

test('reserveRequestQuota serializes concurrent reservations under the hard cap', async () => {
  const id = randomUUID();
  ids.push(id);
  const budgets = { ...uncapped, dailyRequests: 1, monthlyRequests: 1 };
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

test('reserveRequestQuota reuses a per-stage reservation across retries', async () => {
  const id = randomUUID();
  ids.push(id);
  const budgets = { ...uncapped, dailyRequests: 1, monthlyRequests: 1 };
  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (${id},'QuotaIdempotent','Mission','shadow',${sql.json(budgets)},${sql.json([])})
  `;
  const [version] = await sql`INSERT INTO agent_configurations(agent_id,version,config,actor)
      SELECT ${id},1,config,'test' FROM templates WHERE id='support' RETURNING id`;
  const token = randomUUID();
  const [run] = await sql`
    INSERT INTO simulation_runs(agent_id,configuration_id,input,status,result,actor,expires_at,execution_token)
    VALUES (
      ${id},
      ${version.id},
      'quota idempotency',
      'running',
      ${sql.json({ steps: [], actions: [], error: null })},
      'test@example.com',
      ${new Date(Date.now() + 120_000)},
      ${token}
    )
    RETURNING id
  `;
  const signal = AbortSignal.timeout(5_000);
  const periodStart = new Date().toISOString().slice(0, 10);
  const first = await reserveRequestQuota(id, 0, {
    runId: run.id,
    token,
    signal,
    stage: 'evaluator',
  });
  expect(first.reused).toBe(false);
  expect(first.reservation).toEqual({
    stage: 'evaluator',
    reservedMicros: '0',
    reservedRequests: 1,
    periodStart,
  });
  const second = await reserveRequestQuota(id, 0, {
    runId: run.id,
    token,
    signal,
    stage: 'evaluator',
  });
  expect(second.reused).toBe(true);
  expect(second.reservation).toEqual({
    stage: 'evaluator',
    reservedMicros: '0',
    reservedRequests: 1,
    periodStart,
  });
  const [day] =
    await sql`SELECT requests FROM usage_counters WHERE agent_id=${id} AND period='day'`;
  expect(day.requests).toBe(1);
  const [stored] = await sql`SELECT result FROM simulation_runs WHERE id=${run.id}`;
  expect(stored.result.quotaReservations).toEqual([
    { stage: 'evaluator', reservedMicros: '0', reservedRequests: 1, periodStart },
  ]);
});

test('reused quota reservations settle on the original accounting day', async () => {
  const id = randomUUID();
  ids.push(id);
  const budgets = { ...uncapped, dailyRequests: 5, monthlyRequests: 5 };
  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (${id},'QuotaPeriod','Mission','shadow',${sql.json(budgets)},${sql.json([])})
  `;
  const [version] = await sql`INSERT INTO agent_configurations(agent_id,version,config,actor)
      SELECT ${id},1,config,'test' FROM templates WHERE id='support' RETURNING id`;
  const token = randomUUID();
  const originalDay = '2026-11-16';
  const [run] = await sql`
    INSERT INTO simulation_runs(agent_id,configuration_id,input,status,result,actor,expires_at,execution_token)
    VALUES (
      ${id},
      ${version.id},
      'quota period',
      'running',
      ${sql.json({
        steps: [],
        actions: [],
        error: null,
        quotaReservations: [
          { stage: 'evaluator', reservedMicros: '9000', periodStart: originalDay },
        ],
      })},
      'test@example.com',
      ${new Date(Date.now() + 120_000)},
      ${token}
    )
    RETURNING id
  `;
  await sql`
    INSERT INTO usage_counters(agent_id,period,period_start,spend_micros,requests)
    VALUES
      (${id},'day',${originalDay},9000,1),
      (${id},'month','2026-11-01',9000,1)
  `;
  const reused = await reserveRequestQuota(id, 9000, {
    runId: run.id,
    token,
    signal: AbortSignal.timeout(5_000),
    stage: 'evaluator',
  });
  expect(reused.reused).toBe(true);
  await reused(2000);
  const [original] =
    await sql`SELECT spend_micros::text AS spend FROM usage_counters WHERE agent_id=${id} AND period='day' AND period_start=${originalDay}`;
  expect(original.spend).toBe('2000');
  const today = new Date().toISOString().slice(0, 10);
  if (today !== originalDay) {
    const [todayRow] =
      await sql`SELECT spend_micros::text AS spend FROM usage_counters WHERE agent_id=${id} AND period='day' AND period_start=${today}`;
    expect(todayRow ?? null).toBeNull();
  }
});

test('top-ups validate spend against the reservation accounting period', async () => {
  const id = randomUUID();
  ids.push(id);
  const budgets = {
    ...uncapped,
    dailyRequests: 5,
    monthlyRequests: 5,
    dailySpendCents: 1,
    monthlySpendCents: 1,
  };
  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (${id},'QuotaTopUpPeriod','Mission','shadow',${sql.json(budgets)},${sql.json([])})
  `;
  const [version] = await sql`INSERT INTO agent_configurations(agent_id,version,config,actor)
      SELECT ${id},1,config,'test' FROM templates WHERE id='support' RETURNING id`;
  const token = randomUUID();
  const originalDay = '2026-11-16';
  const [run] = await sql`
    INSERT INTO simulation_runs(agent_id,configuration_id,input,status,result,actor,expires_at,execution_token)
    VALUES (
      ${id},
      ${version.id},
      'quota top up period',
      'running',
      ${sql.json({
        steps: [],
        actions: [],
        error: null,
        quotaReservations: [
          { stage: 'evaluator', reservedMicros: '9000', periodStart: originalDay },
        ],
      })},
      'test@example.com',
      ${new Date(Date.now() + 120_000)},
      ${token}
    )
    RETURNING id
  `;
  await sql`
    INSERT INTO usage_counters(agent_id,period,period_start,spend_micros,requests)
    VALUES
      (${id},'day',${originalDay},9000,1),
      (${id},'month','2026-11-01',9000,1)
  `;
  await expect(
    reserveRequestQuota(id, 11000, {
      runId: run.id,
      token,
      signal: AbortSignal.timeout(5_000),
      stage: 'evaluator',
    }),
  ).rejects.toBeInstanceOf(BudgetError);
  const [original] =
    await sql`SELECT spend_micros::text AS spend FROM usage_counters WHERE agent_id=${id} AND period='day' AND period_start=${originalDay}`;
  expect(original.spend).toBe('9000');
});

test('reused quota reservations top up spend when the quote grows', async () => {
  const id = randomUUID();
  ids.push(id);
  const budgets = {
    ...uncapped,
    dailyRequests: 5,
    monthlyRequests: 5,
    dailySpendCents: 1,
    monthlySpendCents: 1,
  };
  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (${id},'QuotaTopUp','Mission','shadow',${sql.json(budgets)},${sql.json([])})
  `;
  const [version] = await sql`INSERT INTO agent_configurations(agent_id,version,config,actor)
      SELECT ${id},1,config,'test' FROM templates WHERE id='support' RETURNING id`;
  const token = randomUUID();
  const periodStart = new Date().toISOString().slice(0, 10);
  const [run] = await sql`
    INSERT INTO simulation_runs(agent_id,configuration_id,input,status,result,actor,expires_at,execution_token)
    VALUES (
      ${id},
      ${version.id},
      'quota top up',
      'running',
      ${sql.json({
        steps: [],
        actions: [],
        error: null,
        quotaReservations: [{ stage: 'evaluator', reservedMicros: '0', periodStart }],
      })},
      'test@example.com',
      ${new Date(Date.now() + 120_000)},
      ${token}
    )
    RETURNING id
  `;
  await sql`
    INSERT INTO usage_counters(agent_id,period,period_start,spend_micros,requests)
    VALUES
      (${id},'day',${periodStart},0,1),
      (${id},'month',${`${periodStart.slice(0, 7)}-01`},0,1)
  `;
  const topped = await reserveRequestQuota(id, 5000, {
    runId: run.id,
    token,
    signal: AbortSignal.timeout(5_000),
    stage: 'evaluator',
  });
  expect(topped.reused).toBe(true);
  expect(topped.reservation).toEqual({
    stage: 'evaluator',
    reservedMicros: '5000',
    periodStart,
  });
  const [day] =
    await sql`SELECT spend_micros::text AS spend, requests FROM usage_counters WHERE agent_id=${id} AND period='day'`;
  expect(day.spend).toBe('5000');
  expect(day.requests).toBe(1);
});

test('stale execution tokens cannot overwrite a reclaimed run', async () => {
  const id = randomUUID();
  ids.push(id);
  const [preset] = await sql`SELECT config FROM templates WHERE id='support'`;
  const config = { ...preset.config, name: 'TokenFence' };
  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (${id},'TokenFence',${config.mission},'shadow',${sql.json(uncapped)},${sql.json([])})
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

test('stale workers cannot rotate the execution token after losing their job claim', async () => {
  const id = randomUUID();
  ids.push(id);
  const [preset] = await sql`SELECT config FROM templates WHERE id='support'`;
  const config = { ...preset.config, name: 'ClaimFence' };
  // Turn off spend caps so the fixture inference mock does not need OpenRouter pricing quotes.
  const budgets = { ...budgetDefaults, dailySpendCents: null, monthlySpendCents: null };
  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (${id},'ClaimFence',${config.mission},'shadow',${sql.json(budgets)},${sql.json([])})
  `;
  const [version] =
    await sql`INSERT INTO agent_configurations(agent_id,version,config,actor) VALUES (${id},1,${sql.json(config)},'test') RETURNING id`;
  await sql`INSERT INTO agent_credentials VALUES (${id},${encryptCredential(id, 'secret-claim')})`;
  await sql`UPDATE controls SET paused=false`;

  const queued = await enqueueSimulation({
    actor: 'test@example.com',
    agentId: id,
    configurationId: version.id,
    input: 'Claim fence prompt',
  });
  const runId = queued.runId!;
  const jobId = queued.jobId!;

  await sql`
    UPDATE jobs
    SET status='claimed', claimed_by='stale-worker', claimed_at=now(),
        claim_expires_at=now() + interval '1 hour', attempts=1
    WHERE id=${jobId}
  `;

  // Lease is reassigned to a replacement worker before the stale claim finishes setup.
  await sql`
    UPDATE jobs
    SET status='claimed', claimed_by='fresh-worker', claimed_at=now(),
        claim_expires_at=now() + interval '1 hour', attempts=2
    WHERE id=${jobId}
  `;

  await processSimulationJob(
    { runId, agentId: id },
    () => async () => ({
      decision: {
        relevant: true,
        priority: 0.9,
        reason: 'fresh',
        actions: [{ type: 'reply', reason: 'ok', draft: 'fresh draft' }],
      },
      inputTokens: 1,
      outputTokens: 1,
    }),
    undefined,
    { jobId, workerId: 'fresh-worker' },
  );

  const [afterFresh] =
    await sql`SELECT status, result, execution_token FROM simulation_runs WHERE id=${runId}`;
  expect(afterFresh.status).toBe('completed');
  expect(afterFresh.result.actions[0].draft).toBe('fresh draft');
  const freshToken = afterFresh.execution_token;

  // Stale worker still thinks it owns the claim — must not rotate the token or overwrite.
  await processSimulationJob(
    { runId, agentId: id },
    () => async () => ({
      decision: {
        relevant: true,
        priority: 0.1,
        reason: 'stale',
        actions: [{ type: 'reply', reason: 'stale', draft: 'stale draft' }],
      },
      inputTokens: 1,
      outputTokens: 1,
    }),
    undefined,
    { jobId, workerId: 'stale-worker' },
  );

  const [final] =
    await sql`SELECT status, result, execution_token FROM simulation_runs WHERE id=${runId}`;
  expect(final.status).toBe('completed');
  expect(final.execution_token).toBe(freshToken);
  expect(final.result.actions[0].draft).toBe('fresh draft');
});

test('queue retries resume checkpointed steps under the hard cap', async () => {
  const id = randomUUID();
  ids.push(id);
  const [preset] = await sql`SELECT config FROM templates WHERE id='support'`;
  const budgets = { ...uncapped, maxToolStepsPerRun: 2, runDeadlineSeconds: 120 };
  const config = { ...preset.config, name: 'StepResume' };
  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (${id},'StepResume',${config.mission},'shadow',${sql.json(budgets)},${sql.json([])})
  `;
  const [version] =
    await sql`INSERT INTO agent_configurations(agent_id,version,config,actor) VALUES (${id},1,${sql.json(config)},'test') RETURNING id`;
  await sql`INSERT INTO agent_credentials VALUES (${id},${encryptCredential(id, 'secret-steps')})`;
  await sql`UPDATE controls SET paused=false`;

  const queued = await enqueueSimulation({
    actor: 'test@example.com',
    agentId: id,
    configurationId: version.id,
    input: 'Step resume prompt',
  });
  expect('runId' in queued && queued.runId).toBeTruthy();
  const runId = queued.runId!;

  const { RetryableInfrastructureError } = await import('@/lib/runtime/errors');
  let calls = 0;
  await expect(
    processSimulationJob({ runId, agentId: id }, () => async () => {
      calls += 1;
      if (calls === 1) {
        return {
          decision: {
            relevant: true,
            priority: 0.8,
            reason: 'needs reply',
            actions: [{ type: 'reply', reason: 'help', draft: null }],
          },
          inputTokens: 1,
          outputTokens: 1,
        };
      }
      // Transport blip before a returned main response — stage stays retryable.
      throw new RetryableInfrastructureError('main-stage provider blip');
    }),
  ).rejects.toBeInstanceOf(RetryableInfrastructureError);

  const [afterFirst] = await sql`SELECT result FROM simulation_runs WHERE id=${runId}`;
  expect(afterFirst.result.steps).toHaveLength(1);
  expect(afterFirst.result.steps[0].stage).toBe('evaluator');
  expect(afterFirst.result.dispatchedStages).toEqual(['evaluator']);

  await processSimulationJob({ runId, agentId: id }, () => async () => {
    calls += 1;
    return {
      decision: {
        relevant: true,
        priority: 0.9,
        reason: 'refined',
        actions: [{ type: 'reply', reason: 'help', draft: 'Here to help.' }],
      },
      inputTokens: 2,
      outputTokens: 2,
    };
  });

  // Evaluator once, failed main once, then main succeeds on retry.
  expect(calls).toBe(3);
  const [done] = await sql`SELECT status, result FROM simulation_runs WHERE id=${runId}`;
  expect(done.status).toBe('completed');
  expect(done.result.steps).toHaveLength(2);
  expect(done.result.actions[0].draft).toBe('Here to help.');
});

test('queue retries keep reservation-only progress under the hard cap', async () => {
  const id = randomUUID();
  ids.push(id);
  const [preset] = await sql`SELECT config FROM templates WHERE id='support'`;
  const budgets = { ...uncapped, maxToolStepsPerRun: 2, runDeadlineSeconds: 120 };
  const config = { ...preset.config, name: 'ReserveOnly' };
  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (${id},'ReserveOnly',${config.mission},'shadow',${sql.json(budgets)},${sql.json([])})
  `;
  const [version] =
    await sql`INSERT INTO agent_configurations(agent_id,version,config,actor) VALUES (${id},1,${sql.json(config)},'test') RETURNING id`;
  await sql`INSERT INTO agent_credentials VALUES (${id},${encryptCredential(id, 'secret-reserve')})`;
  await sql`UPDATE controls SET paused=false`;

  const queued = await enqueueSimulation({
    actor: 'test@example.com',
    agentId: id,
    configurationId: version.id,
    input: 'Reservation-only resume prompt',
  });
  expect('runId' in queued && queued.runId).toBeTruthy();
  const runId = queued.runId!;

  // Mimic a durable post-dispatch checkpoint failure: provider was reached, response never saved.
  await sql`
    UPDATE simulation_runs
    SET result = ${sql.json({
      reservedStages: ['evaluator'],
      dispatchedStages: ['evaluator'],
      steps: [],
      actions: [],
      error: null,
    })}
    WHERE id = ${runId}
  `;

  let calls = 0;
  await processSimulationJob({ runId, agentId: id }, () => async () => {
    calls += 1;
    return {
      decision: {
        relevant: true,
        priority: 0.8,
        reason: 'should not run',
        actions: [{ type: 'reply', reason: 'help', draft: 'nope' }],
      },
      inputTokens: 1,
      outputTokens: 1,
    };
  });

  expect(calls).toBe(0);
  const [done] = await sql`SELECT status, result FROM simulation_runs WHERE id=${runId}`;
  expect(done.status).toBe('failed');
  expect(done.result.reservedStages).toEqual(['evaluator']);
  expect(done.result.steps).toHaveLength(0);
  expect(done.result.error).toContain('already used this model step');
});

test('retries preserve the original run deadline', async () => {
  const id = randomUUID();
  ids.push(id);
  const [preset] = await sql`SELECT config FROM templates WHERE id='support'`;
  const budgets = { ...uncapped, runDeadlineSeconds: 30 };
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
    VALUES (${id},'DeadLetter',${config.mission},'shadow',${sql.json(uncapped)},${sql.json([])})
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
    VALUES (${id},'PauseRetry',${config.mission},'shadow',${sql.json(uncapped)},${sql.json([])})
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
    VALUES (${id},'OrphanDead',${config.mission},'shadow',${sql.json(uncapped)},${sql.json([])})
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

test('finalizeOrphanedCompletedSimulationRuns clears runs linked to completed jobs', async () => {
  const id = randomUUID();
  ids.push(id);
  const [preset] = await sql`SELECT config FROM templates WHERE id='support'`;
  const config = { ...preset.config, name: 'OrphanCompleted' };
  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (${id},'OrphanCompleted',${config.mission},'shadow',${sql.json(uncapped)},${sql.json([])})
  `;
  const [version] =
    await sql`INSERT INTO agent_configurations(agent_id,version,config,actor) VALUES (${id},1,${sql.json(config)},'test') RETURNING id`;
  const [job] = await sql`
    INSERT INTO jobs(type,payload,status,attempts,max_attempts,available_at,finished_at)
    VALUES (
      ${SIMULATION_JOB_TYPE},
      ${sql.json({ runId: 'pending' })},
      'completed',
      1,
      5,
      now(),
      now()
    )
    RETURNING id
  `;
  const [run] = await sql`
    INSERT INTO simulation_runs(agent_id,configuration_id,input,status,result,actor,expires_at,execution_token,job_id)
    VALUES (
      ${id},
      ${version.id},
      'orphan-completed',
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
  await finalizeOrphanedCompletedSimulationRuns();
  const [done] =
    await sql`SELECT status, defer_reason, result FROM simulation_runs WHERE id=${run.id}`;
  expect(done.status).toBe('failed');
  expect(done.defer_reason).toContain('retries exhausted');
  expect(done.result.error).toContain('reconciled after job completed');
});

test('OpenRouter spend reservations serialize and missing prices require both caps off', async () => {
  const id = randomUUID();
  ids.push(id);
  const capped = { ...budgetDefaults, dailySpendCents: 1, monthlySpendCents: null };
  await sql`INSERT INTO agents(id,name,mission,budgets) VALUES (${id}, 'Spend', 'Fixture', ${sql.json(capped)})`;
  await expect(reserveRequestQuota(id)).rejects.toThrow(budgetViolationMessage('unknown-price'));
  const concurrent = await Promise.allSettled([
    reserveRequestQuota(id, 8000),
    reserveRequestQuota(id, 8000),
  ]);
  const admitted = concurrent.find((result) => result.status === 'fulfilled');
  const denied = concurrent.find((result) => result.status === 'rejected');
  expect(admitted?.status).toBe('fulfilled');
  expect(denied?.reason).toBeInstanceOf(BudgetError);
  expect(denied?.reason.message).toBe(budgetViolationMessage('daily-spend-reservation'));

  await admitted?.value(1000);
  const settle = await reserveRequestQuota(id, 9000);
  await settle(2000);
  expect([
    ...(await sql`SELECT requests, spend_micros::int FROM usage_counters WHERE agent_id=${id}`),
  ]).toEqual([
    { requests: 2, spend_micros: 3000 },
    { requests: 2, spend_micros: 3000 },
  ]);

  // Conservative multi-call reservation releases unused request slots on settle.
  const multi = await reserveRequestQuota(id, 0, { providerCalls: 11 });
  await multi(0, 1);
  expect([
    ...(await sql`SELECT requests FROM usage_counters WHERE agent_id=${id} AND period='day'`),
  ]).toEqual([{ requests: 3 }]);

  await sql`UPDATE agents SET budgets=${sql.json({ ...uncapped, dailyRequests: 3 })} WHERE id=${id}`;
  await expect(reserveRequestQuota(id, 0)).rejects.toThrow(
    budgetViolationMessage('daily-requests'),
  );
});

test('Stop wins against a model request waiting to reserve quota', async () => {
  const id = randomUUID();
  ids.push(id);
  await sql`INSERT INTO agents(id,name,mission,budgets) VALUES (${id},'Stop while reserving','Fixture',${sql.json(budgetDefaults)})`;
  const [version] = await sql`
    INSERT INTO agent_configurations(agent_id,version,config,actor)
    SELECT ${id},1,config,'test' FROM templates WHERE id='support' RETURNING id
  `;
  const queued = await enqueueSimulation({
    actor: 'test',
    agentId: id,
    configurationId: version.id,
    input: 'Fixture',
  });
  const runId = queued.runId!;
  const canReserve = Promise.withResolvers<void>();
  const reachedQuote = Promise.withResolvers<void>();
  let providerCalls = 0;
  const [ready] = await sql`SELECT id FROM jobs WHERE id=${queued.jobId!}`;
  expect(ready.id).toBe(queued.jobId);
  await sql`INSERT INTO agent_credentials VALUES (${id},${encryptCredential(id, 'stop-fixture')})`;
  const execute = processSimulationJob({ runId }, () =>
    Object.assign(
      async () => {
        providerCalls++;
        throw new Error('Unexpected inference');
      },
      {
        quote: async () => {
          reachedQuote.resolve();
          await canReserve.promise;
          return undefined;
        },
      },
    ),
  );
  await reachedQuote.promise;
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM agents WHERE id=${id} FOR UPDATE`;
      canReserve.resolve();
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const [state] = await sql`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND query ILIKE '%from "agents"%for update'
        ) AS waiting`;
        waiting = state.waiting;
        if (!waiting) await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      await tx`UPDATE agents SET lifecycle='stopped' WHERE id=${id}`;
      await tx`UPDATE simulation_runs SET status='interrupted' WHERE id=${runId}`;
    });
  } finally {
    canReserve.resolve();
    await execute;
  }
  expect(providerCalls).toBe(0);
  expect(await sql`SELECT requests FROM usage_counters WHERE agent_id=${id}`).toHaveLength(0);
  const [run] = await sql`SELECT status FROM simulation_runs WHERE id=${runId}`;
  expect(run.status).toBe('interrupted');
});

test('simulated introductions enforce scoped consent before and after human review', async () => {
  const id = randomUUID();
  ids.push(id);
  await sql`UPDATE controls SET paused=false`;
  await sql`INSERT INTO agents(id,name,mission,budgets) VALUES (${id}, 'Consent', 'Fixture', ${sql.json(uncapped)})`;
  const [version] = await sql`
    INSERT INTO agent_configurations(agent_id,version,config,actor)
    SELECT ${id},1,config,'test' FROM templates WHERE id='support' RETURNING id
  `;
  await sql`INSERT INTO agent_credentials VALUES (${id},${encryptCredential(id, 'consent-fixture')})`;
  const actor = 'test@example.com';
  const run = async () => {
    const queued = await enqueueSimulation({
      actor,
      agentId: id,
      configurationId: version.id,
      input: 'Synthetic introduction',
      recipients: ['fixture-a', 'fixture-b'],
    });
    await processSimulationJob({ runId: queued.runId! }, () => async () => ({
      decision: {
        relevant: true,
        priority: 0.5,
        reason: 'Fixture',
        actions: [{ type: 'introduce', reason: 'Fixture', draft: null }],
      },
      inputTokens: 4,
      outputTokens: 5,
    }));
    const [stored] = await sql`SELECT result FROM simulation_runs WHERE id=${queued.runId!}`;
    return { runId: queued.runId!, proposal: stored.result.actions[0] };
  };
  const consent = (
    recipient: string,
    granted: boolean,
    scope: 'introduce' | 'escalate' = 'introduce',
  ) =>
    recordConsent({
      actor,
      agentId: id,
      recipient,
      granted,
      scope,
      evidence: 'Synthetic evidence reference',
    });

  await consent('fixture-a', true);
  await consent('fixture-b', true, 'escalate');
  expect((await run()).proposal.policy).toBe('deny');
  await consent('fixture-b', true);
  const proposed = await run();
  expect(proposed.proposal.policy).toBe('needs-approval');
  await consent('fixture-b', false);
  expect(
    await reviewProposedAction(actor, id, proposed.proposal.intentId, 'approved'),
  ).toMatchObject({ error: expect.stringContaining('consent') });
  await consent('fixture-b', true);
  expect(
    await reviewProposedAction(actor, id, proposed.proposal.intentId, 'approved'),
  ).toMatchObject({ message: expect.stringContaining('approved') });

  const [intent] = await sql`SELECT * FROM action_intents WHERE id=${proposed.proposal.intentId}`;
  expect(intent.review_status).toBe('approved');
  expect(intent.decision).toBe('suppressed');
  await consent('fixture-b', false);
  const ctx = (await loadPolicyContext(id, actor, proposed.runId))!;
  expect(
    await authorizeAction(ctx, {
      type: 'introduce',
      idempotencyKey: intent.idempotency_key,
      recipients: intent.recipients,
    }),
  ).toMatchObject({ decision: 'deny' });
  const policyLog =
    await sql`SELECT decision, actor FROM policy_decisions WHERE intent_id=${intent.id} ORDER BY created_at`;
  expect(policyLog.map((row) => row.decision)).toEqual([
    'needs-approval',
    'deny',
    'suppressed',
    'deny',
  ]);
  expect(policyLog.every((row) => row.actor === actor)).toBe(true);
});
