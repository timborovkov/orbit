import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import postgres from 'postgres';

import './shim-server-only';

import { budgetDefaults, budgetViolationMessage } from '@/lib/budgets';
import { startJobWorker } from '@/lib/queue/worker';
import { expireStaleApprovals, reconcileSuspendedApprovals } from '@/lib/runtime/approval-work';
import {
  enqueueSimulation,
  processSimulationJob,
  SIMULATION_JOB_TYPE,
} from '@/lib/runtime/execute';
import { encryptCredential } from '@/lib/runtime/secrets';
import { persistApprovalTools } from '@/lib/server/lifecycle-mutations';
import { reviewProposedAction } from '@/lib/server/policy-mutations';

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
const actor = 'approvals@example.com';

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

async function seedAgent(options: {
  approvalTools?: string[];
  approvalExpiresAfterHours?: number | null;
  approvalOnReject?: 'continue' | 'end';
}) {
  const id = randomUUID();
  ids.push(id);
  await sql`UPDATE controls SET paused=false`;
  await sql`
    INSERT INTO agents(
      id, name, mission, lifecycle, budgets, enabled_tools, approval_tools,
      approval_expires_after_hours, approval_on_reject
    )
    VALUES (
      ${id}, 'Approvals', 'Fixture', 'shadow', ${sql.json(uncapped)}, ${sql.json([])},
      ${sql.json(options.approvalTools ?? ['reply'])},
      ${options.approvalExpiresAfterHours ?? null},
      ${options.approvalOnReject ?? 'continue'}
    )
  `;
  const [version] = await sql`
    INSERT INTO agent_configurations(agent_id, version, config, actor)
    SELECT ${id}, 1, config, 'test' FROM templates WHERE id='support' RETURNING id
  `;
  await sql`INSERT INTO agent_credentials VALUES (${id}, ${encryptCredential(id, 'approval-fixture')})`;
  return { id, versionId: version.id as string };
}

test('disabled approval tools leave ordinary writes on the suppress path', async () => {
  const { id, versionId } = await seedAgent({ approvalTools: [] });
  const queued = await enqueueSimulation({
    actor,
    agentId: id,
    configurationId: versionId,
    input: 'Ordinary reply fixture',
  });
  await processSimulationJob({ runId: queued.runId! }, () => async () => ({
    decision: {
      relevant: true,
      priority: 0.4,
      reason: 'Fixture',
      actions: [{ type: 'reply', reason: 'Fixture', draft: 'Hello' }],
    },
    inputTokens: 2,
    outputTokens: 2,
  }));
  const [run] = await sql`SELECT status, result FROM simulation_runs WHERE id=${queued.runId!}`;
  expect(run.status).toBe('completed');
  expect(run.result.actions[0].policy).toBe('suppressed');
  expect(
    await sql`SELECT id FROM action_intents WHERE agent_id=${id} AND review_status='pending'`,
  ).toHaveLength(0);
});

test('needs-approval suspends the run, releases the job, and resume never redispatches', async () => {
  const { id, versionId } = await seedAgent({ approvalTools: ['reply'] });
  await sql`UPDATE agents SET budgets = ${sql.json({ ...uncapped, maxConcurrentRuns: 2 })} WHERE id=${id}`;
  const queued = await enqueueSimulation({
    actor,
    agentId: id,
    configurationId: versionId,
    input: 'Needs approval fixture',
  });
  let providerCalls = 0;
  await processSimulationJob({ runId: queued.runId! }, () => async () => {
    providerCalls++;
    return {
      decision: {
        relevant: true,
        priority: 0.7,
        reason: 'Fixture',
        actions: [{ type: 'reply', reason: 'Needs review', draft: 'Pending draft' }],
      },
      inputTokens: 3,
      outputTokens: 4,
    };
  });
  expect(providerCalls).toBe(2); // evaluator + main
  const [suspended] =
    await sql`SELECT status, result, job_id FROM simulation_runs WHERE id=${queued.runId!}`;
  expect(suspended.status).toBe('awaiting_approval');
  expect(suspended.result.dispatchedStages).toEqual(expect.arrayContaining(['evaluator', 'main']));
  const [job] = await sql`SELECT status, claimed_by FROM jobs WHERE id=${suspended.job_id}`;
  expect(job.status).toBe('completed');
  expect(job.claimed_by).toBeNull();

  // Execution-deadline cleanup must not reject suspended approvals when another run starts.
  await sql`UPDATE simulation_runs SET expires_at = now() - interval '1 hour' WHERE id=${queued.runId!}`;
  const second = await enqueueSimulation({
    actor,
    agentId: id,
    configurationId: versionId,
    input: 'Sibling run while first awaits approval',
  });
  expect(second.runId).toBeTruthy();
  const [stillWaiting] = await sql`SELECT status FROM simulation_runs WHERE id=${queued.runId!}`;
  expect(stillWaiting.status).toBe('awaiting_approval');
  expect(
    await sql`SELECT id FROM action_intents WHERE agent_id=${id} AND review_status='pending'`,
  ).toHaveLength(1);

  const [intent] =
    await sql`SELECT id FROM action_intents WHERE agent_id=${id} AND review_status='pending'`;
  expect(intent).toBeTruthy();
  expect(
    await reviewProposedAction(actor, id, intent.id, 'approved', {
      editedPayload: { draft: 'Edited draft' },
    }),
  ).toMatchObject({ message: expect.stringContaining('approved') });

  const [edited] = await sql`SELECT payload, decision FROM action_intents WHERE id=${intent.id}`;
  expect(edited.payload.draft).toBe('Edited draft');
  expect(edited.decision).toBe('suppressed');

  const [resumed] =
    await sql`SELECT status, job_id, expires_at FROM simulation_runs WHERE id=${queued.runId!}`;
  expect(resumed.status).toBe('queued');
  expect(new Date(resumed.expires_at).getTime()).toBeGreaterThan(Date.now());
  const resumeCalls = { count: 0 };
  await processSimulationJob({ runId: queued.runId! }, () => async () => {
    resumeCalls.count++;
    throw new Error('must not redispatch');
  });
  expect(resumeCalls.count).toBe(0);
  const [done] = await sql`SELECT status, result FROM simulation_runs WHERE id=${queued.runId!}`;
  expect(done.status).toBe('completed');
  expect(done.result.actions[0]).toMatchObject({
    policy: 'suppressed',
    draft: 'Edited draft',
  });
});

test('reject continues the run by default and expiry auto-rejects stale items', async () => {
  const { id, versionId } = await seedAgent({
    approvalTools: ['reply'],
    approvalExpiresAfterHours: 1,
  });
  const queued = await enqueueSimulation({
    actor,
    agentId: id,
    configurationId: versionId,
    input: 'Reject fixture',
  });
  await processSimulationJob({ runId: queued.runId! }, () => async () => ({
    decision: {
      relevant: true,
      priority: 0.5,
      reason: 'Fixture',
      actions: [{ type: 'reply', reason: 'Reject me', draft: 'No' }],
    },
    inputTokens: 1,
    outputTokens: 1,
  }));
  const [intent] =
    await sql`SELECT id FROM action_intents WHERE agent_id=${id} AND review_status='pending'`;
  expect(await reviewProposedAction(actor, id, intent.id, 'rejected')).toMatchObject({
    message: expect.stringContaining('rejected'),
  });
  await processSimulationJob({ runId: queued.runId! }, () => async () => {
    throw new Error('must not redispatch');
  });
  const [done] = await sql`SELECT status, result FROM simulation_runs WHERE id=${queued.runId!}`;
  expect(done.status).toBe('completed');
  expect(done.result.actions[0].policy).toBe('deny');

  const expiredAgent = await seedAgent({ approvalTools: ['like'] });
  const expiredQueued = await enqueueSimulation({
    actor,
    agentId: expiredAgent.id,
    configurationId: expiredAgent.versionId,
    input: 'Expiry fixture',
  });
  await processSimulationJob({ runId: expiredQueued.runId! }, () => async () => ({
    decision: {
      relevant: true,
      priority: 0.5,
      reason: 'Fixture',
      actions: [{ type: 'like', reason: 'Expire me', draft: null }],
    },
    inputTokens: 1,
    outputTokens: 1,
  }));
  await sql`
    UPDATE action_intents
    SET review_expires_at = now() - interval '1 minute'
    WHERE agent_id=${expiredAgent.id} AND review_status='pending'
  `;
  expect(await expireStaleApprovals()).toEqual({ expired: 1 });
  const [expiredIntent] = await sql`
    SELECT review_status, review_note FROM action_intents
    WHERE agent_id=${expiredAgent.id} AND review_status IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `;
  expect(expiredIntent.review_status).toBe('rejected');
  expect(expiredIntent.review_note).toBe('expired');
  await processSimulationJob({ runId: expiredQueued.runId! }, () => async () => {
    throw new Error('must not redispatch');
  });
  const [expiredRun] =
    await sql`SELECT status FROM simulation_runs WHERE id=${expiredQueued.runId!}`;
  expect(expiredRun.status).toBe('completed');
});

test('worker-shared expiry resumes without redistributing paid stages', async () => {
  const { id, versionId } = await seedAgent({ approvalTools: ['bookmark'] });
  const queued = await enqueueSimulation({
    actor,
    agentId: id,
    configurationId: versionId,
    input: 'Worker expiry fixture',
  });
  await processSimulationJob({ runId: queued.runId! }, () => async () => ({
    decision: {
      relevant: true,
      priority: 0.2,
      reason: 'Fixture',
      actions: [{ type: 'bookmark', reason: 'Hold', draft: null }],
    },
    inputTokens: 1,
    outputTokens: 1,
  }));
  await sql`
    UPDATE action_intents
    SET review_expires_at = now() - interval '5 minutes'
    WHERE agent_id=${id} AND review_status='pending'
  `;

  // Same module the worker imports on its reconcile tick.
  expect(await expireStaleApprovals()).toEqual({ expired: 1 });
  const [intent] = await sql`
    SELECT review_status, review_note FROM action_intents
    WHERE agent_id=${id} AND review_status IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `;
  expect(intent.review_status).toBe('rejected');
  expect(intent.review_note).toBe('expired');

  const workerId = `expiry-${randomUUID()}`;
  const worker = startJobWorker({
    workerId,
    handlers: {
      [SIMULATION_JOB_TYPE]: async (job, signal) => {
        await processSimulationJob(
          job.payload,
          () => async () => {
            throw new Error('resume must not redispatch');
          },
          signal,
          { jobId: job.id, workerId },
        );
      },
    },
    pollMs: 40,
    recoveryMs: 200,
    leaseMs: 5_000,
  });
  for (let i = 0; i < 40; i++) {
    const [run] = await sql`SELECT status FROM simulation_runs WHERE id=${queued.runId!}`;
    if (run.status === 'completed') break;
    await Bun.sleep(40);
  }
  await worker.stop();
  const [finished] = await sql`SELECT status FROM simulation_runs WHERE id=${queued.runId!}`;
  expect(finished.status).toBe('completed');
});

async function suspendFixture(options: Parameters<typeof seedAgent>[0] = {}) {
  const agent = await seedAgent(options);
  const queued = await enqueueSimulation({
    actor,
    agentId: agent.id,
    configurationId: agent.versionId,
    input: 'Approval fixture',
  });
  if (!queued.runId) throw new Error('Fixture failed to queue');
  const runId = queued.runId;
  await processSimulationJob({ runId }, () => async () => ({
    decision: {
      relevant: true,
      priority: 0.5,
      reason: 'Approval fixture',
      actions: [{ type: 'reply', reason: 'Review me', draft: 'A draft' }],
    },
    inputTokens: 3,
    outputTokens: 2,
  }));
  const [intent] =
    await sql`SELECT id FROM action_intents WHERE run_id=${runId} AND review_status='pending'`;
  const [run] = await sql`SELECT status, job_id FROM simulation_runs WHERE id=${runId}`;
  expect(run.status).toBe('awaiting_approval');
  return { ...agent, runId, intentId: intent.id as string, jobId: run.job_id as string };
}

test('a failed continuation insert rolls back the review and allows a retry', async () => {
  const fixture = await suspendFixture();
  await sql`
    ALTER TABLE jobs ADD CONSTRAINT approvals_test_reject_resume
    CHECK (idempotency_key NOT LIKE '%:resume:%') NOT VALID
  `;
  try {
    await expect(
      reviewProposedAction(actor, fixture.id, fixture.intentId, 'approved'),
    ).rejects.toThrow();
  } finally {
    await sql`ALTER TABLE jobs DROP CONSTRAINT approvals_test_reject_resume`;
  }
  const [intent] = await sql`SELECT review_status FROM action_intents WHERE id=${fixture.intentId}`;
  const [run] = await sql`SELECT status, job_id FROM simulation_runs WHERE id=${fixture.runId}`;
  expect(intent.review_status).toBe('pending');
  expect(run).toMatchObject({ status: 'awaiting_approval', job_id: fixture.jobId });
  expect(await sql`SELECT id FROM audit WHERE action LIKE ${`%${fixture.intentId}%`}`).toHaveLength(
    0,
  );

  expect(await reviewProposedAction(actor, fixture.id, fixture.intentId, 'approved')).toEqual({
    message: 'Proposal approved.',
  });
  const [queued] = await sql`SELECT status, job_id FROM simulation_runs WHERE id=${fixture.runId}`;
  expect(queued.status).toBe('queued');
  expect(queued.job_id).not.toBe(fixture.jobId);
});

test('reconciliation repairs stranded approved runs without an OpenRouter credential', async () => {
  const fixture = await suspendFixture();
  await sql`UPDATE action_intents SET review_status='approved', decision='suppressed', reviewed_by=${actor} WHERE id=${fixture.intentId}`;
  await sql`DELETE FROM agent_credentials WHERE agent_id=${fixture.id}`;
  await reconcileSuspendedApprovals();
  await reconcileSuspendedApprovals();
  const [queued] = await sql`SELECT status, job_id FROM simulation_runs WHERE id=${fixture.runId}`;
  expect(queued.status).toBe('queued');
  expect(await sql`SELECT id FROM jobs WHERE payload->>'runId'=${fixture.runId}`).toHaveLength(2);

  const original = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    await processSimulationJob({ runId: fixture.runId }, () => {
      throw new Error('Continuation must never construct an inference client');
    });
  } finally {
    if (original !== undefined) process.env.OPENROUTER_API_KEY = original;
  }
  const [run] = await sql`SELECT status, result FROM simulation_runs WHERE id=${fixture.runId}`;
  expect(run.status).toBe('completed');
  expect(run.result.actions[0].policy).toBe('suppressed');
  expect(run.result.steps).toHaveLength(2);
});

test('expired reviews reject atomically, end the run and audit sibling cancellations', async () => {
  const fixture = await suspendFixture({ approvalOnReject: 'end' });
  const [sibling] = await sql`
    INSERT INTO action_intents(agent_id, run_id, action_type, idempotency_key, decision, review_status)
    VALUES (${fixture.id}, ${fixture.runId}, 'like', ${randomUUID()}, 'needs-approval', 'pending')
    RETURNING id
  `;
  await sql`UPDATE action_intents SET review_expires_at=now()-interval '1 minute' WHERE id=${fixture.intentId}`;
  expect(await reviewProposedAction(actor, fixture.id, fixture.intentId, 'approved')).toEqual({
    error: 'This proposal expired and was rejected.',
  });
  const [run] = await sql`SELECT status, result FROM simulation_runs WHERE id=${fixture.runId}`;
  expect(run.status).toBe('failed');
  expect(run.result.actions[0].policy).toBe('deny');
  const [review] =
    await sql`SELECT review_note, reviewed_by FROM action_intents WHERE id=${fixture.intentId}`;
  expect(review).toMatchObject({ review_note: 'expired', reviewed_by: 'system:approval-expiry' });
  const [cancelled] = await sql`SELECT review_status FROM action_intents WHERE id=${sibling.id}`;
  expect(cancelled.review_status).toBe('rejected');
  expect(
    await sql`SELECT id FROM audit WHERE action LIKE ${`%${fixture.intentId}%`} OR action LIKE ${`%${sibling.id}%`}`,
  ).toHaveLength(2);
  expect(await sql`SELECT id FROM jobs WHERE payload->>'runId'=${fixture.runId}`).toHaveLength(1);
});

test('a rejection before suspension applies the selected version’s end policy', async () => {
  const fixture = await suspendFixture({ approvalOnReject: 'end' });
  // Restore the state between the model checkpoint and final suspension.
  await sql`UPDATE simulation_runs SET status='running', defer_reason=NULL WHERE id=${fixture.runId}`;
  await sql`UPDATE jobs SET status='pending', finished_at=NULL WHERE id=${fixture.jobId}`;
  await sql`UPDATE agent_configurations SET approval_settings=${sql.json({
    approvalTools: ['reply'],
    approvalOnReject: 'end',
    approvalSpendCents: null,
    approvalExpiresAfterHours: null,
  })} WHERE id=${fixture.versionId}`;
  await sql`UPDATE agents SET approval_on_reject='continue' WHERE id=${fixture.id}`;
  expect(await reviewProposedAction(actor, fixture.id, fixture.intentId, 'rejected')).toEqual({
    message: 'Proposal rejected.',
  });
  const [running] = await sql`SELECT status FROM simulation_runs WHERE id=${fixture.runId}`;
  expect(running.status).toBe('running');

  await processSimulationJob({ runId: fixture.runId }, () => {
    throw new Error('Continuation must never construct an inference client');
  });
  const [run] = await sql`SELECT status, result FROM simulation_runs WHERE id=${fixture.runId}`;
  expect(run.status).toBe('failed');
  expect(run.result.actions[0].policy).toBe('deny');
  expect(await sql`SELECT id FROM jobs WHERE payload->>'runId'=${fixture.runId}`).toHaveLength(1);
});

test('saving per-agent rules versions them and keeps old runs on their selected policy', async () => {
  const agent = await seedAgent({ approvalTools: [] });
  const updated = await persistApprovalTools(actor, agent.id, 1, {
    approvalTools: ['reply'],
    approvalExpiresAfterHours: 2,
    approvalOnReject: 'end',
    approvalSpendCents: null,
  });
  expect(updated).toEqual({ message: 'Approval requirements saved.' });
  const versions = await sql`
    SELECT id, approval_settings FROM agent_configurations WHERE agent_id=${agent.id} ORDER BY version
  `;
  expect(versions.map((version) => version.approval_settings.approvalTools)).toEqual([
    [],
    ['reply'],
  ]);
  const runVersion = async (configurationId: string) => {
    const queued = await enqueueSimulation({
      actor,
      agentId: agent.id,
      configurationId,
      input: 'Version fixture',
    });
    if (!queued.runId) throw new Error('Fixture failed to queue');
    await processSimulationJob({ runId: queued.runId }, () => async () => ({
      decision: {
        relevant: true,
        priority: 0.5,
        reason: 'Version fixture',
        actions: [
          { type: 'reply', reason: 'Review based on the selected version', draft: 'A draft' },
        ],
      },
      inputTokens: 3,
      outputTokens: 2,
    }));
    const [run] = await sql`SELECT status FROM simulation_runs WHERE id=${queued.runId}`;
    return run.status;
  };
  expect(await runVersion(versions[0].id)).toBe('completed');
  expect(await runVersion(versions[1].id)).toBe('awaiting_approval');
  const second = await enqueueSimulation({
    actor,
    agentId: agent.id,
    configurationId: versions[1].id,
    input: 'Wait occupies the active slot',
  });
  expect(second).toMatchObject({ error: budgetViolationMessage('concurrency') });
});
