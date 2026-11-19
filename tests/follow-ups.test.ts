import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import postgres from 'postgres';

import { budgetDefaults } from '@/lib/budgets';
import { claimJobs, completeJob } from '@/lib/queue/jobs';
import { startJobWorker } from '@/lib/queue/worker';
import {
  finalizeFollowUpExecution,
  FOLLOW_UP_JOB_TYPE,
  processFollowUpJob,
  reconcileDeadFollowUpJobs,
} from '@/lib/runtime/follow-ups/process';
import { FOLLOW_UP_LIFECYCLE_POLICY } from '@/lib/runtime/follow-ups/types';
import { cancelFollowUp, scheduleFollowUp } from '@/lib/server/follow-up-mutations';
import { persistLifecycle } from '@/lib/server/lifecycle-mutations';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://orbit:orbit_dev@127.0.0.1:5432/orbit_test';
const sql = postgres(databaseUrl);
const ids: string[] = [];
const admin = 'admin@follow-ups.test';

afterAll(async () => {
  try {
    for (const id of ids) {
      await sql`DELETE FROM agent_activity_events WHERE agent_id=${id}`;
      await sql`UPDATE follow_ups SET job_id=NULL WHERE agent_id=${id}`;
      await sql`DELETE FROM follow_ups WHERE agent_id=${id}`;
      await sql`DELETE FROM jobs WHERE payload->>'agentId'=${id}`;
      await sql`DELETE FROM agent_configurations WHERE agent_id=${id}`;
      await sql`DELETE FROM agents WHERE id=${id}`;
      await sql`DELETE FROM audit WHERE actor=${admin}`;
    }
  } finally {
    await sql.end();
  }
});

async function createAgent(name: string, lifecycle = 'shadow') {
  const id = randomUUID();
  ids.push(id);
  const [template] = await sql`SELECT config FROM templates WHERE id='support'`;
  const config = { ...template!.config, name };
  await sql`INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES(${id},${name},${config.mission},${lifecycle},${sql.json(budgetDefaults)},${sql.json([])})`;
  await sql`INSERT INTO agent_configurations(agent_id,version,config,actor)
    VALUES(${id},1,${sql.json(config)},${admin})`;
  return id;
}

test('documents skip-and-record lifecycle policy', () => {
  expect(FOLLOW_UP_LIFECYCLE_POLICY).toContain('skip-and-record');
  expect(FOLLOW_UP_LIFECYCLE_POLICY).toContain('paused');
  expect(FOLLOW_UP_LIFECYCLE_POLICY).toContain('stopped');
});

test('schedules a delayed follow-up with transactional enqueue', async () => {
  const agentId = await createAgent('Follow-up schedule');
  const dueAt = new Date(Date.now() + 60_000);
  const result = await scheduleFollowUp(admin, {
    agentId,
    subject: 'Check demo booking',
    note: 'Internal only',
    dueAt,
  });
  expect(result).toMatchObject({ message: 'Follow-up scheduled.' });
  if ('error' in result) throw new Error(result.error);

  const [row] = await sql`SELECT * FROM follow_ups WHERE id=${result.followUpId}`;
  expect(row!.status).toBe('scheduled');
  expect(row!.subject).toBe('Check demo booking');
  expect(row!.job_id).toBe(result.jobId);

  const [job] = await sql`SELECT * FROM jobs WHERE id=${result.jobId}`;
  expect(job!.type).toBe(FOLLOW_UP_JOB_TYPE);
  expect(job!.status).toBe('pending');
  expect(new Date(job!.available_at as string).getTime()).toBeGreaterThan(Date.now() - 1000);
  expect(job!.idempotency_key).toBe(`followup:${result.followUpId}`);

  const [audit] =
    await sql`SELECT action FROM audit WHERE actor=${admin} ORDER BY created_at DESC LIMIT 1`;
  expect(String(audit!.action)).toContain('Scheduled follow-up');
});

test('survives a worker restart before the due time', async () => {
  const agentId = await createAgent('Follow-up restart');
  const dueAt = new Date(Date.now() + 200);
  const scheduled = await scheduleFollowUp(admin, {
    agentId,
    subject: 'Restart survival',
    dueAt,
  });
  if ('error' in scheduled) throw new Error(scheduled.error);

  const earlyWorker = startJobWorker({
    workerId: `follow-up-early-${randomUUID()}`,
    handlers: {
      [FOLLOW_UP_JOB_TYPE]: async (job) => {
        await processFollowUpJob(job.payload, job.attempts);
      },
    },
    pollMs: 20,
    recoveryMs: 5_000,
    leaseMs: 5_000,
  });
  await Bun.sleep(80);
  await earlyWorker.stop();

  const [before] = await sql`SELECT status FROM follow_ups WHERE id=${scheduled.followUpId}`;
  expect(before!.status).toBe('scheduled');

  await Bun.sleep(Math.max(0, dueAt.getTime() - Date.now() + 20));

  const lateWorker = startJobWorker({
    workerId: `follow-up-late-${randomUUID()}`,
    handlers: {
      [FOLLOW_UP_JOB_TYPE]: async (job) => {
        await processFollowUpJob(job.payload, job.attempts);
      },
    },
    pollMs: 20,
    recoveryMs: 5_000,
    leaseMs: 5_000,
  });

  for (let i = 0; i < 50; i++) {
    const [row] = await sql`SELECT status FROM follow_ups WHERE id=${scheduled.followUpId}`;
    if (row?.status === 'completed') break;
    await Bun.sleep(40);
  }
  await lateWorker.stop();

  const [after] =
    await sql`SELECT status, outcome_kind, outcome FROM follow_ups WHERE id=${scheduled.followUpId}`;
  expect(after!.status).toBe('completed');
  expect(after!.outcome_kind).toBe('executed');
  expect(String(after!.outcome)).toContain('Internal outcome only');

  const events =
    await sql`SELECT kind FROM agent_activity_events WHERE follow_up_id=${scheduled.followUpId}`;
  expect(events).toHaveLength(1);
  expect(events[0]!.kind).toBe('follow_up.completed');
});

test('executes exactly once when retried or duplicated', async () => {
  const agentId = await createAgent('Follow-up once');
  const followUpId = randomUUID();
  const dueAt = new Date(Date.now() - 1_000);

  const [job] = await sql`
    INSERT INTO jobs(type,payload,status,available_at,idempotency_key)
    VALUES(
      ${FOLLOW_UP_JOB_TYPE},
      ${sql.json({ followUpId, agentId })},
      'pending',
      ${dueAt.toISOString()},
      ${`followup:${followUpId}`}
    )
    RETURNING id`;
  await sql`INSERT INTO follow_ups(id,agent_id,source,created_by,subject,note,due_at,status,job_id)
    VALUES(${followUpId},${agentId},'admin',${admin},'Once only','',${dueAt.toISOString()},'scheduled',${job!.id})`;

  // Duplicate job without shared idempotency (simulates a race).
  const [dup] = await sql`
    INSERT INTO jobs(type,payload,status,available_at,idempotency_key)
    VALUES(
      ${FOLLOW_UP_JOB_TYPE},
      ${sql.json({ followUpId, agentId })},
      'pending',
      ${dueAt.toISOString()},
      ${`followup-dup:${followUpId}`}
    )
    RETURNING id`;

  const first = await finalizeFollowUpExecution(followUpId, { attempts: 1 });
  const second = await finalizeFollowUpExecution(followUpId, { attempts: 2 });
  expect(first).toEqual({ recorded: true, status: 'completed' });
  expect(second).toEqual({ recorded: false, status: 'completed' });

  await processFollowUpJob({ followUpId, agentId }, 3);

  const [row] =
    await sql`SELECT status, attempts, outcome_kind FROM follow_ups WHERE id=${followUpId}`;
  expect(row!.status).toBe('completed');
  expect(row!.outcome_kind).toBe('executed');
  expect(Number(row!.attempts)).toBe(1);

  const events = await sql`SELECT id FROM agent_activity_events WHERE follow_up_id=${followUpId}`;
  expect(events).toHaveLength(1);

  // Drain both jobs so they do not poison later claims.
  for (const id of [job!.id as string, dup!.id as string]) {
    const claimed = await claimJobs({
      workerId: `drain-${id}`,
      types: [FOLLOW_UP_JOB_TYPE],
      limit: 1,
    });
    const match = claimed.find((c) => c.id === id);
    if (match) await completeJob(match.id, match.claimedBy!);
  }
});

test('admin cancellation prevents execution', async () => {
  const agentId = await createAgent('Follow-up cancel');
  const dueAt = new Date(Date.now() + 30_000);
  const scheduled = await scheduleFollowUp(admin, {
    agentId,
    subject: 'Cancel me',
    dueAt,
  });
  if ('error' in scheduled) throw new Error(scheduled.error);

  const cancelled = await cancelFollowUp(admin, agentId, scheduled.followUpId);
  expect(cancelled).toMatchObject({ message: 'Follow-up cancelled.' });

  const [row] =
    await sql`SELECT status, outcome_kind FROM follow_ups WHERE id=${scheduled.followUpId}`;
  expect(row!.status).toBe('cancelled');
  expect(row!.outcome_kind).toBe('cancelled');

  const [job] = await sql`SELECT status FROM jobs WHERE id=${scheduled.jobId}`;
  expect(job!.status).toBe('cancelled');

  const again = await finalizeFollowUpExecution(scheduled.followUpId, { attempts: 1 });
  expect(again).toEqual({ recorded: false, status: 'cancelled' });

  const events =
    await sql`SELECT kind FROM agent_activity_events WHERE follow_up_id=${scheduled.followUpId}`;
  expect(events.map((e) => e.kind)).toEqual(['follow_up.cancelled']);
});

test('paused agents skip-and-record scheduled follow-ups', async () => {
  const agentId = await createAgent('Follow-up paused');
  const dueAt = new Date(Date.now() + 60_000);
  const scheduled = await scheduleFollowUp(admin, {
    agentId,
    subject: 'Pause skip',
    dueAt,
  });
  if ('error' in scheduled) throw new Error(scheduled.error);

  const paused = await persistLifecycle(admin, agentId, 'paused');
  expect(paused).toMatchObject({ message: expect.stringContaining('paused') });

  const [row] =
    await sql`SELECT status, outcome_kind, outcome FROM follow_ups WHERE id=${scheduled.followUpId}`;
  expect(row!.status).toBe('skipped');
  expect(row!.outcome_kind).toBe('skipped_lifecycle');
  expect(String(row!.outcome)).toContain('paused');

  const [job] = await sql`SELECT status FROM jobs WHERE id=${scheduled.jobId}`;
  expect(job!.status).toBe('cancelled');

  const events =
    await sql`SELECT kind, summary FROM agent_activity_events WHERE follow_up_id=${scheduled.followUpId}`;
  expect(events).toHaveLength(1);
  expect(events[0]!.kind).toBe('follow_up.skipped');
});

test('stopped agents skip-and-record; claimed handler respects lifecycle', async () => {
  const agentId = await createAgent('Follow-up stopped');
  const dueAt = new Date(Date.now() - 500);
  const followUpId = randomUUID();
  const [job] = await sql`
    INSERT INTO jobs(type,payload,status,available_at,idempotency_key)
    VALUES(
      ${FOLLOW_UP_JOB_TYPE},
      ${sql.json({ followUpId, agentId })},
      'pending',
      ${dueAt.toISOString()},
      ${`followup:${followUpId}`}
    )
    RETURNING id`;
  await sql`INSERT INTO follow_ups(id,agent_id,source,created_by,subject,note,due_at,status,job_id)
    VALUES(${followUpId},${agentId},'admin',${admin},'Stop skip','',${dueAt.toISOString()},'scheduled',${job!.id})`;
  await sql`UPDATE agents SET lifecycle='stopped' WHERE id=${agentId}`;

  await processFollowUpJob({ followUpId, agentId }, 1);

  const [row] = await sql`SELECT status, outcome_kind FROM follow_ups WHERE id=${followUpId}`;
  expect(row!.status).toBe('skipped');
  expect(row!.outcome_kind).toBe('skipped_lifecycle');
});

test('concurrent execute and cancel complete under agent-first locking', async () => {
  const agentId = await createAgent('Follow-up lock order');
  const dueAt = new Date(Date.now() - 1_000);
  const scheduled = await scheduleFollowUp(admin, {
    agentId,
    subject: 'Lock race',
    dueAt,
  });
  if ('error' in scheduled) throw new Error(scheduled.error);

  const raced = Promise.all([
    finalizeFollowUpExecution(scheduled.followUpId, { attempts: 1, agentId }),
    cancelFollowUp(admin, agentId, scheduled.followUpId),
    finalizeFollowUpExecution(scheduled.followUpId, { attempts: 2, agentId }),
    persistLifecycle(admin, agentId, 'paused'),
  ]);
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Deadlock suspected: lock race exceeded 5s')), 5_000);
  });
  await Promise.race([raced, timeout]);

  const [row] = await sql`SELECT status FROM follow_ups WHERE id=${scheduled.followUpId}`;
  expect(['completed', 'cancelled', 'skipped']).toContain(row!.status);
});

test('reconcileDeadFollowUpJobs finalizes scheduled rows whose jobs are already dead', async () => {
  const agentId = await createAgent('Follow-up reconcile');
  const dueAt = new Date(Date.now() - 1_000);
  const followUpId = randomUUID();
  const [job] = await sql`
    INSERT INTO jobs(type,payload,status,available_at,idempotency_key,last_error,finished_at)
    VALUES(
      ${FOLLOW_UP_JOB_TYPE},
      ${sql.json({ followUpId, agentId })},
      'dead',
      ${dueAt.toISOString()},
      ${`followup:${followUpId}`},
      ${'Lease expired after max attempts'},
      ${dueAt.toISOString()}
    )
    RETURNING id`;
  await sql`INSERT INTO follow_ups(id,agent_id,source,created_by,subject,note,due_at,status,job_id)
    VALUES(${followUpId},${agentId},'admin',${admin},'Orphaned dead job','',${dueAt.toISOString()},'scheduled',${job!.id})`;

  const recovered = await reconcileDeadFollowUpJobs();
  expect(recovered).toBeGreaterThanOrEqual(1);

  const [row] =
    await sql`SELECT status, outcome_kind, outcome FROM follow_ups WHERE id=${followUpId}`;
  expect(row!.status).toBe('failed');
  expect(row!.outcome_kind).toBe('failed');
  expect(String(row!.outcome)).toContain('Lease expired');

  const events = await sql`SELECT kind FROM agent_activity_events WHERE follow_up_id=${followUpId}`;
  expect(events).toHaveLength(1);
  expect(events[0]!.kind).toBe('follow_up.failed');

  // Idempotent: already failed rows are ignored.
  expect(await reconcileDeadFollowUpJobs()).toBe(0);
});
