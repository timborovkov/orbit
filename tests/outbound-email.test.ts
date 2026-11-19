import { randomUUID } from 'node:crypto';
import { afterAll, expect, mock, test } from 'bun:test';
import postgres from 'postgres';

import './shim-server-only';

import { budgetDefaults } from '@/lib/budgets';
import { db } from '@/lib/db';
import { cancelWorkForLifecycle } from '@/lib/lifecycle-work';
import { claimJobs, completeJob, enqueueJob } from '@/lib/queue/jobs';
import {
  proposeEmailReplyFromDraft,
  recoverEmailReplyProposalIfNeeded,
} from '@/lib/runtime/email/propose';
import { processEmailReceiveJob } from '@/lib/runtime/email/receive';
import {
  finalizeExhaustedOutboundJob,
  processEmailSendJob,
  reconcileCancelledOutboundJobs,
  reconcileDeadOutboundJobs,
} from '@/lib/runtime/email/send';
import { EMAIL_RECEIVE_JOB } from '@/lib/runtime/email/settings';
import { createStubEmailTransport } from '@/lib/runtime/email/transport';
import { isRetryableInfrastructureError, retryableStore } from '@/lib/runtime/errors';
import { processEmailDraftJob } from '@/lib/runtime/execute';
import { EMAIL_SEND_JOB } from '@/lib/runtime/outbound/types';
import { setEmailEnabled } from '@/lib/server/email-mutations';
import { getEmailInbox } from '@/lib/server/email-queries';
import { reviewProposedAction } from '@/lib/server/policy-mutations';

mock.module('@/lib/auth', () => ({
  requireAdmin: async () => 'admin@example.test',
  getAdminEmail: async () => 'admin@example.test',
  checkOrigin: async () => undefined,
}));

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://orbit:orbit_dev@localhost:5432/orbit_test';
process.env.DATABASE_URL = databaseUrl;
const sql = postgres(databaseUrl);
const ids: string[] = [];
const workerId = 'outbound-email-fixture-worker';
const admin = 'admin@example.test';
const signal = new AbortController().signal;

const originalPause = await sql`SELECT paused FROM controls WHERE id=1`;
const originalEnv = {
  RESEND_INBOUND_DOMAIN: process.env.RESEND_INBOUND_DOMAIN,
  RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
};
process.env.RESEND_INBOUND_DOMAIN = 'inbound.example.test';
process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.alloc(32, 19).toString('base64')}`;

afterAll(async () => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (originalPause[0]) {
    await sql`UPDATE controls SET paused=${originalPause[0].paused}`;
  }
  try {
    for (const id of ids) {
      await sql`DELETE FROM outbound_actions WHERE agent_id=${id}`;
      await sql`DELETE FROM policy_decisions WHERE agent_id=${id}`;
      await sql`DELETE FROM action_intents WHERE agent_id=${id}`;
      await sql`DELETE FROM email_messages WHERE agent_id=${id}`;
      await sql`DELETE FROM email_threads WHERE agent_id=${id}`;
      await sql`DELETE FROM email_mailboxes WHERE agent_id=${id}`;
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

async function createAgent(lifecycle: 'shadow' | 'live' = 'live') {
  const id = randomUUID();
  ids.push(id);
  const [template] = await sql`SELECT config FROM templates WHERE id='support'`;
  const config = { ...template!.config, name: `Outbound ${lifecycle}` };
  await sql`INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES(${id},${config.name},${config.mission},${lifecycle},${sql.json(budgetDefaults)},'[]'::jsonb)`;
  const [version] = await sql`INSERT INTO agent_configurations(agent_id,version,config,actor)
    VALUES(${id},1,${sql.json(config)},${admin}) RETURNING id`;
  expect(await setEmailEnabled(admin, id, true)).toMatchObject({
    message: 'Inbound email enabled.',
  });
  return { id, version: version!.id as string };
}

async function seedDraft(
  agentId: string,
  configurationId: string,
  draft = 'Thanks for writing in.',
) {
  const threadId = randomUUID();
  const messageId = randomUUID();
  const runId = randomUUID();
  const intentId = randomUUID();
  await sql`INSERT INTO email_threads(id,agent_id) VALUES(${threadId},${agentId})`;
  await sql`INSERT INTO simulation_runs(id,agent_id,configuration_id,input,actor,origin,status,result,expires_at,finished_at)
    VALUES(${runId},${agentId},${configurationId},'Help','fixture','email','completed',${sql.json({
      error: null,
      actions: [],
      steps: [
        {
          stage: 'main',
          model: 'fixture',
          inputTokens: 1,
          outputTokens: 1,
          decision: {
            relevant: true,
            priority: 1,
            reason: 'ok',
            actions: [],
            answer: draft,
            citations: [],
          },
        },
      ],
    })},now(),now())`;
  await sql`INSERT INTO email_messages(
    id,agent_id,resend_email_id,event,sender,subject,received_at,configuration_id,run_id,thread_id,body,message_id,in_reply_to,reference_ids
  ) VALUES(
    ${messageId},${agentId},${messageId},'{}'::jsonb,'Customer <customer@example.test>','Billing question',now(),${configurationId},${runId},${threadId},
    'Need help', 'billing@example.test', '{}', '{}'
  )`;
  await sql`INSERT INTO action_intents(
    id,agent_id,run_id,action_type,recipients,review_status,payload,idempotency_key,decision,reasons
  ) VALUES(
    ${intentId},${agentId},${runId},'email.send',${sql.json(['customer@example.test'])},'pending',
    ${sql.json({
      draft,
      reason: 'Inbound email reply draft',
      emailMessageId: messageId,
      threadId,
    })},
    ${`email.send:${messageId}`},'needs-approval',${sql.json(['An administrator must review this proposal.'])}
  )`;
  return { threadId, messageId, runId, intentId, draft };
}

async function releasePause() {
  await sql`UPDATE controls SET paused=false`;
}

async function enablePause() {
  await sql`UPDATE controls SET paused=true`;
}

async function processQueuedSend(transport: ReturnType<typeof createStubEmailTransport>) {
  const claimed = await claimJobs({ workerId, limit: 5, types: [EMAIL_SEND_JOB] });
  expect(claimed.length).toBeGreaterThan(0);
  for (const job of claimed) {
    await processEmailSendJob(job, signal, transport);
    await completeJob(job.id, workerId);
  }
  return claimed;
}

test('approval sends exactly once; retries and duplicate jobs do not double-send', async () => {
  await releasePause();
  const agent = await createAgent('live');
  const seeded = await seedDraft(agent.id, agent.version);
  const transport = createStubEmailTransport();

  const approved = await reviewProposedAction(admin, agent.id, seeded.intentId, 'approved');
  expect(approved).toMatchObject({ message: expect.stringContaining('queued') });

  const first = await processQueuedSend(transport);
  expect(transport.calls).toHaveLength(1);
  expect(transport.calls[0]?.to).toBe('customer@example.test');
  expect(transport.calls[0]?.subject).toBe('Re: Billing question');
  expect(transport.calls[0]?.headers['In-Reply-To']).toBe('<billing@example.test>');
  expect(transport.calls[0]?.text).toBe(seeded.draft);

  const [outbound] =
    await sql`SELECT status, provider_message_id, idempotency_key FROM outbound_actions WHERE intent_id=${seeded.intentId}`;
  expect(outbound?.status).toBe('sent');
  expect(outbound?.provider_message_id).toBeTruthy();

  // Re-process the same outbound id (retry / duplicate job) must not call transport again.
  await processEmailSendJob(
    {
      ...first[0]!,
      payload: { ...first[0]!.payload },
    },
    signal,
    transport,
  );
  expect(transport.calls).toHaveLength(1);

  const [usage] =
    await sql`SELECT outbound_actions FROM usage_counters WHERE agent_id=${agent.id} AND period='day'`;
  expect(usage?.outbound_actions).toBe(1);
});

test('Shadow stays draft-only after approval', async () => {
  await releasePause();
  const agent = await createAgent('shadow');
  const seeded = await seedDraft(agent.id, agent.version);
  const result = await reviewProposedAction(admin, agent.id, seeded.intentId, 'approved');
  expect(result).toMatchObject({ message: 'Proposal approved.' });

  const [intent] =
    await sql`SELECT decision, review_status FROM action_intents WHERE id=${seeded.intentId}`;
  expect(intent).toMatchObject({ decision: 'suppressed', review_status: 'approved' });
  const outbound = await sql`SELECT id FROM outbound_actions WHERE intent_id=${seeded.intentId}`;
  expect(outbound).toHaveLength(0);
  const jobs =
    await sql`SELECT id FROM jobs WHERE type=${EMAIL_SEND_JOB} AND payload->>'agentId'=${agent.id}`;
  expect(jobs).toHaveLength(0);
});

test('global pause after approval blocks dispatch without sending', async () => {
  await releasePause();
  const agent = await createAgent('live');
  const seeded = await seedDraft(agent.id, agent.version);
  expect(await reviewProposedAction(admin, agent.id, seeded.intentId, 'approved')).toMatchObject({
    message: expect.stringContaining('queued'),
  });
  await enablePause();

  const transport = createStubEmailTransport();
  await processQueuedSend(transport);
  expect(transport.calls).toHaveLength(0);

  const [outbound] =
    await sql`SELECT status, reason FROM outbound_actions WHERE intent_id=${seeded.intentId}`;
  expect(outbound?.status).toBe('blocked');
  expect(String(outbound?.reason)).toContain('Global outbound pause');
});

test('agent pause after approval blocks dispatch', async () => {
  await releasePause();
  const agent = await createAgent('live');
  const seeded = await seedDraft(agent.id, agent.version);
  expect(await reviewProposedAction(admin, agent.id, seeded.intentId, 'approved')).toMatchObject({
    message: expect.stringContaining('queued'),
  });
  await sql`UPDATE agents SET lifecycle='paused' WHERE id=${agent.id}`;

  const transport = createStubEmailTransport();
  await processQueuedSend(transport);
  expect(transport.calls).toHaveLength(0);
  const [outbound] =
    await sql`SELECT status, reason FROM outbound_actions WHERE intent_id=${seeded.intentId}`;
  expect(outbound?.status).toBe('blocked');
  expect(String(outbound?.reason)).toContain('paused');
});

test('rejection never sends', async () => {
  await releasePause();
  const agent = await createAgent('live');
  const seeded = await seedDraft(agent.id, agent.version);
  expect(await reviewProposedAction(admin, agent.id, seeded.intentId, 'rejected')).toMatchObject({
    message: 'Proposal rejected.',
  });

  const outbound = await sql`SELECT id FROM outbound_actions WHERE intent_id=${seeded.intentId}`;
  expect(outbound).toHaveLength(0);
  const jobs =
    await sql`SELECT id FROM jobs WHERE type=${EMAIL_SEND_JOB} AND payload->>'agentId'=${agent.id}`;
  expect(jobs).toHaveLength(0);
});

test('edited approval body is what gets sent', async () => {
  await releasePause();
  const agent = await createAgent('live');
  const seeded = await seedDraft(agent.id, agent.version, 'Original draft');
  const edited = 'Edited administrator reply.';
  expect(
    await reviewProposedAction(admin, agent.id, seeded.intentId, 'approved', {
      editedPayload: { draft: edited },
    }),
  ).toMatchObject({ message: expect.stringContaining('queued') });

  const transport = createStubEmailTransport();
  await processQueuedSend(transport);
  expect(transport.calls[0]?.text).toBe(edited);

  const inbox = await getEmailInbox(agent.id, seeded.threadId, 1, 1);
  const message = inbox.messages.find((row) => row.id === seeded.messageId);
  expect(message?.review?.draft).toBe(edited);
  expect(message?.sendOutcome?.status).toBe('sent');
});

test('completed email draft recovers a missing approval intent', async () => {
  await releasePause();
  const agent = await createAgent('live');
  const threadId = randomUUID();
  const messageId = randomUUID();
  const runId = randomUUID();
  const draft = 'Recovered proposal draft.';
  const result = {
    error: null,
    actions: [],
    steps: [
      {
        stage: 'main' as const,
        model: 'fixture',
        inputTokens: 1,
        outputTokens: 1,
        decision: {
          relevant: true,
          priority: 1,
          reason: 'ok',
          actions: [],
          answer: draft,
          citations: [],
        },
      },
    ],
  };
  await sql`INSERT INTO email_threads(id,agent_id) VALUES(${threadId},${agent.id})`;
  await sql`INSERT INTO simulation_runs(id,agent_id,configuration_id,input,actor,origin,status,result,expires_at,finished_at)
    VALUES(${runId},${agent.id},${agent.version},'Help','fixture','email','completed',${sql.json(result)},now(),now())`;
  await sql`INSERT INTO email_messages(
    id,agent_id,resend_email_id,event,sender,subject,received_at,configuration_id,run_id,thread_id,body,message_id
  ) VALUES(
    ${messageId},${agent.id},${messageId},'{}'::jsonb,'Customer <customer@example.test>','Recover me',now(),${agent.version},${runId},${threadId},
    'Need help','recover@example.test'
  )`;

  expect(
    await sql`SELECT id FROM action_intents WHERE idempotency_key=${`email.send:${messageId}`}`,
  ).toHaveLength(0);

  // Simulate a worker retry that finds the run already completed without an intent.
  await processEmailDraftJob({ runId }, undefined, signal);
  const intents =
    await sql`SELECT id, review_status, payload->>'draft' AS draft FROM action_intents WHERE idempotency_key=${`email.send:${messageId}`}`;
  expect(intents).toHaveLength(1);
  expect(intents[0]).toMatchObject({ review_status: 'pending', draft });

  // Idempotent recovery paths stay stable.
  expect(
    await recoverEmailReplyProposalIfNeeded({
      agentId: agent.id,
      runId,
      actor: admin,
      result,
    }),
  ).toMatchObject({ intentId: intents[0]!.id });
  expect(
    await proposeEmailReplyFromDraft({ agentId: agent.id, runId, actor: admin, result }),
  ).toMatchObject({
    intentId: intents[0]!.id,
  });

  const inbox = await getEmailInbox(agent.id, threadId, 1, 1);
  expect(inbox.messages[0]?.review?.status).toBe('pending');
  expect(inbox.messages[0]?.review?.draft).toBe(draft);
});

test('dead-lettered email.send finalizes outbound as failed', async () => {
  await releasePause();
  const agent = await createAgent('live');
  const seeded = await seedDraft(agent.id, agent.version);
  expect(await reviewProposedAction(admin, agent.id, seeded.intentId, 'approved')).toMatchObject({
    message: expect.stringContaining('queued'),
  });

  const [outbound] =
    await sql`SELECT id, job_id FROM outbound_actions WHERE intent_id=${seeded.intentId}`;
  expect(outbound?.id).toBeTruthy();
  await sql`UPDATE outbound_actions SET status='sending', dispatched_at=now() WHERE id=${outbound!.id}`;
  await sql`UPDATE jobs SET status='dead', last_error='provider unavailable' WHERE id=${outbound!.job_id}`;

  await finalizeExhaustedOutboundJob(
    { outboundId: outbound!.id, agentId: agent.id },
    'provider unavailable',
  );
  const [failed] = await sql`SELECT status, reason FROM outbound_actions WHERE id=${outbound!.id}`;
  expect(failed?.status).toBe('failed');
  expect(String(failed?.reason)).toContain('retries exhausted');

  // Reconcile path repairs stranded sending rows when the callback previously failed.
  await sql`UPDATE outbound_actions SET status='sending', reason=null, completed_at=null WHERE id=${outbound!.id}`;
  await reconcileDeadOutboundJobs();
  const [reconciled] =
    await sql`SELECT status, reason, completed_at FROM outbound_actions WHERE id=${outbound!.id}`;
  expect(reconciled?.status).toBe('failed');
  expect(String(reconciled?.reason)).toContain('retries exhausted');
  expect(reconciled?.completed_at).toBeTruthy();
});

test('merging provisional threads retargets outbound without failing receive', async () => {
  await releasePause();
  const agent = await createAgent('live');
  const parentRfc = `parent-${randomUUID()}@example.test`;
  const childA = randomUUID();
  const childB = randomUUID();
  const parentMsg = randomUUID();
  const threadA = randomUUID();
  const threadB = randomUUID();
  const parentThread = randomUUID();
  const intentId = randomUUID();
  const outboundId = randomUUID();

  // Two out-of-order replies land on provisional threads before the parent arrives.
  await sql`INSERT INTO email_threads(id,agent_id,provisional) VALUES
    (${threadA},${agent.id},true),(${threadB},${agent.id},true),(${parentThread},${agent.id},false)`;
  await sql`INSERT INTO email_messages(
    id,agent_id,resend_email_id,event,sender,subject,received_at,configuration_id,thread_id,body,message_id,in_reply_to,reference_ids
  ) VALUES
    (${childA},${agent.id},${childA},'{}'::jsonb,'a@example.test','Re: Thread',now(),${agent.version},${threadA},
      'first child',${`a-${childA}@example.test`},${[parentRfc]},${[parentRfc]}),
    (${childB},${agent.id},${childB},'{}'::jsonb,'b@example.test','Re: Thread',now(),${agent.version},${threadB},
      'second child',${`b-${childB}@example.test`},${[parentRfc]},${[parentRfc]})`;

  await sql`INSERT INTO action_intents(
    id,agent_id,action_type,recipients,review_status,payload,idempotency_key,decision,reasons
  ) VALUES(
    ${intentId},${agent.id},'email.send',${sql.json(['b@example.test'])},'approved',
    ${sql.json({ draft: 'hi', emailMessageId: childB, threadId: threadB })},
    ${`email.send:${childB}`},'allow',${sql.json(['approved'])}
  )`;
  await sql`INSERT INTO outbound_actions(
    id,agent_id,intent_id,action_type,status,idempotency_key,body,email_message_id,thread_id
  ) VALUES(
    ${outboundId},${agent.id},${intentId},'email.send','queued',${`outbound:${childB}`},'hi',${childB},${threadB}
  )`;

  const parentJob = await db().transaction((tx) =>
    enqueueJob(tx, {
      type: EMAIL_RECEIVE_JOB,
      payload: { messageId: parentMsg, agentId: agent.id },
      idempotencyKey: `email.receive:${agent.id}:${parentMsg}`,
    }),
  );
  await sql`INSERT INTO email_messages(
    id,agent_id,resend_email_id,event,sender,subject,received_at,configuration_id,thread_id,receive_job_id
  ) VALUES(
    ${parentMsg},${agent.id},${parentMsg},'{}'::jsonb,'parent@example.test','Thread',now(),${agent.version},${parentThread},${parentJob.id}
  )`;

  const [claimed] = await claimJobs({ workerId, types: [EMAIL_RECEIVE_JOB], limit: 1 });
  expect(claimed?.id).toBe(parentJob.id);
  await processEmailReceiveJob(claimed!, workerId, signal, async () => ({
    body: 'parent body',
    messageId: parentRfc,
    inReplyTo: [],
    referenceIds: [],
  }));
  await completeJob(claimed!.id, workerId);

  const [outbound] =
    await sql`SELECT thread_id, agent_id, status FROM outbound_actions WHERE id=${outboundId}`;
  expect(outbound?.agent_id).toBe(agent.id);
  expect(outbound?.status).toBe('queued');
  // lateChildren are ordered by thread id; the lowest provisional id survives the merge.
  const [surviving, deleted] = [threadA, threadB].sort();
  expect(outbound?.thread_id).toBe(surviving);
  expect(await sql`SELECT id FROM email_threads WHERE id=${deleted!}`).toHaveLength(0);
  expect(await sql`SELECT id FROM email_threads WHERE id=${surviving!}`).toHaveLength(1);
});

test('inbox pending stays true while outbound is queued or sending', async () => {
  await releasePause();
  const agent = await createAgent('live');
  const seeded = await seedDraft(agent.id, agent.version);
  expect(await reviewProposedAction(admin, agent.id, seeded.intentId, 'approved')).toMatchObject({
    message: expect.stringContaining('queued'),
  });

  const queued = await getEmailInbox(agent.id, seeded.threadId, 1, 1);
  expect(queued.pending).toBe(true);
  expect(queued.messages[0]?.sendOutcome?.status).toBe('queued');

  await sql`UPDATE outbound_actions SET status='sending' WHERE intent_id=${seeded.intentId}`;
  const sending = await getEmailInbox(agent.id, seeded.threadId, 1, 1);
  expect(sending.pending).toBe(true);
  expect(sending.messages[0]?.sendOutcome?.status).toBe('sending');

  await sql`UPDATE outbound_actions SET status='sent', completed_at=now(), provider_message_id='msg_fixture' WHERE intent_id=${seeded.intentId}`;
  await sql`UPDATE jobs SET status='completed' WHERE type=${EMAIL_SEND_JOB} AND payload->>'agentId'=${agent.id}`;
  const done = await getEmailInbox(agent.id, seeded.threadId, 1, 1);
  expect(done.pending).toBe(false);
  expect(done.messages[0]?.sendOutcome?.status).toBe('sent');
});

test('proposal persistence failures are classified as retryable', async () => {
  try {
    await retryableStore(async () => {
      throw new Error('connection reset during proposal insert');
    });
    expect.unreachable('retryableStore should have thrown');
  } catch (error) {
    expect(isRetryableInfrastructureError(error)).toBe(true);
  }
});

test('pausing an agent finalizes queued outbound when email.send is cancelled', async () => {
  await releasePause();
  const agent = await createAgent('live');
  const seeded = await seedDraft(agent.id, agent.version);
  expect(await reviewProposedAction(admin, agent.id, seeded.intentId, 'approved')).toMatchObject({
    message: expect.stringContaining('queued'),
  });

  const [before] =
    await sql`SELECT id, job_id, status FROM outbound_actions WHERE intent_id=${seeded.intentId}`;
  expect(before?.status).toBe('queued');
  expect(before?.job_id).toBeTruthy();

  const cancelled = await cancelWorkForLifecycle(agent.id, 'paused');
  expect(cancelled).toContain(before!.job_id);

  const [job] = await sql`SELECT status FROM jobs WHERE id=${before!.job_id}`;
  expect(job?.status).toBe('cancelled');

  const [outbound] = await sql`SELECT status, reason FROM outbound_actions WHERE id=${before!.id}`;
  expect(outbound?.status).toBe('blocked');
  expect(String(outbound?.reason)).toContain('paused');

  const inbox = await getEmailInbox(agent.id, seeded.threadId, 1, 1);
  expect(inbox.pending).toBe(false);
  expect(inbox.messages[0]?.sendOutcome?.status).toBe('blocked');
});

test('reconcileCancelledOutboundJobs repairs stranded queued rows after cancelled jobs', async () => {
  await releasePause();
  const agent = await createAgent('live');
  const seeded = await seedDraft(agent.id, agent.version);
  expect(await reviewProposedAction(admin, agent.id, seeded.intentId, 'approved')).toMatchObject({
    message: expect.stringContaining('queued'),
  });

  const [outbound] =
    await sql`SELECT id, job_id FROM outbound_actions WHERE intent_id=${seeded.intentId}`;
  await sql`UPDATE jobs SET status='cancelled', finished_at=now() WHERE id=${outbound!.job_id}`;
  // Simulate a lifecycle cancel that updated jobs but failed before outbound finalize.
  await sql`UPDATE outbound_actions SET status='queued', reason=null, completed_at=null WHERE id=${outbound!.id}`;

  await reconcileCancelledOutboundJobs();
  const [repaired] =
    await sql`SELECT status, reason, completed_at FROM outbound_actions WHERE id=${outbound!.id}`;
  expect(repaired?.status).toBe('blocked');
  expect(String(repaired?.reason)).toContain('cancelled');
  expect(repaired?.completed_at).toBeTruthy();
});
