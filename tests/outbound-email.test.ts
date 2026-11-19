import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import postgres from 'postgres';

import { budgetDefaults } from '@/lib/budgets';
import { claimJobs, completeJob } from '@/lib/queue/jobs';
import { processEmailSendJob } from '@/lib/runtime/email/send';
import { createStubEmailTransport } from '@/lib/runtime/email/transport';
import { EMAIL_SEND_JOB } from '@/lib/runtime/outbound/types';
import { setEmailEnabled } from '@/lib/server/email-mutations';
import { reviewProposedAction } from '@/lib/server/policy-mutations';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://orbit:orbit_dev@localhost:5432/orbit_test';
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
});
