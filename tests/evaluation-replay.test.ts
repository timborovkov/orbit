import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import postgres from 'postgres';

import { budgetDefaults } from '@/lib/budgets';
import { closeDb, db } from '@/lib/db';
import { cancelWorkForLifecycle } from '@/lib/lifecycle-work';
import { authorizeAction, loadPolicyContext } from '@/lib/policy/gateway';
import { authorizeOutboundDispatch } from '@/lib/policy/outbound';
import { emailKnowledgeQuery } from '@/lib/runtime/email/input';
import {
  EVALUATION_REPLAY_JOB,
  finalizeCancelledEvaluationComparisons,
  finalizeExhaustedEvaluationReplayJob,
  processEvaluationReplayJob,
  reconcileDeadEvaluationReplayJobs,
  saveEvaluationCase,
  startEvaluationComparison,
} from '@/lib/runtime/evaluation';
import { encryptCredential } from '@/lib/runtime/secrets';
import { draftAnswerFromResult, type ModelCall } from '@/lib/runtime/simulation';
import { DEMO_SARAH_EMAIL_CASE_INPUT } from '@/lib/seed/modules/evaluations';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://orbit:orbit_dev@localhost:5432/orbit_test';
const sql = postgres(databaseUrl);
const ids: string[] = [];
const admin = 'admin@example.com';
const uncapped = { ...budgetDefaults, dailySpendCents: null, monthlySpendCents: null };

process.env.DATABASE_URL = databaseUrl;
process.env.AUTH_DISABLED = 'false';
process.env.ORBIT_ADMIN_EMAIL = admin;
process.env.ORBIT_ADMIN_PASSWORD = 'test-only-password-123456';
process.env.ORBIT_ENCRYPTION_KEY = 'a'.repeat(64);
afterAll(async () => {
  for (const id of ids) {
    await sql`DELETE FROM evaluation_comparisons WHERE agent_id=${id}`;
    await sql`DELETE FROM evaluation_cases WHERE agent_id=${id}`;
    await sql`DELETE FROM email_messages WHERE agent_id=${id}`;
    await sql`DELETE FROM email_threads WHERE agent_id=${id}`;
    await sql`DELETE FROM policy_decisions WHERE agent_id=${id}`;
    await sql`DELETE FROM action_intents WHERE agent_id=${id}`;
    await sql`DELETE FROM usage_counters WHERE agent_id=${id}`;
    await sql`DELETE FROM simulation_runs WHERE agent_id=${id}`;
    await sql`DELETE FROM jobs WHERE payload->>'agentId'=${id}`;
    await sql`DELETE FROM agent_credentials WHERE agent_id=${id}`;
    await sql`DELETE FROM agent_configurations WHERE agent_id=${id}`;
    await sql`DELETE FROM agents WHERE id=${id}`;
  }
  await closeDb();
  await sql.end();
});

function fixtureInference(): (key: string) => ModelCall {
  return () => async () => ({
    decision: {
      relevant: true,
      priority: 0.7,
      reason: 'fixture',
      actions: [{ type: 'reply', reason: 'Fixture reply', draft: 'Draft reply' }],
    },
    inputTokens: 3,
    outputTokens: 5,
    costMicros: 0,
  });
}

async function seedAgent() {
  const id = randomUUID();
  ids.push(id);
  await sql`
    INSERT INTO agents(id, name, mission, lifecycle, budgets, enabled_tools)
    VALUES (
      ${id},
      'Eval Agent',
      'Compare configurations',
      'shadow',
      ${sql.json(uncapped)},
      ${sql.json([])}
    )
  `;
  const [v1] = await sql`
    INSERT INTO agent_configurations(agent_id, version, config, actor)
    VALUES (
      ${id},
      1,
      ${sql.json({
        name: 'Eval Agent',
        role: 'Sales',
        personality: 'Direct',
        mission: 'Compare configurations',
        instructions: 'Be concise',
        engagementCriteria: 'B2B leads',
        mainModel: 'fixture/main',
        evaluatorModel: 'fixture/eval',
      })},
      ${admin}
    )
    RETURNING id, version
  `;
  const [v2] = await sql`
    INSERT INTO agent_configurations(agent_id, version, config, actor)
    VALUES (
      ${id},
      2,
      ${sql.json({
        name: 'Eval Agent',
        role: 'Sales',
        personality: 'Warmer',
        mission: 'Compare configurations',
        instructions: 'Be helpful',
        engagementCriteria: 'B2B leads',
        mainModel: 'fixture/main',
        evaluatorModel: 'fixture/eval',
      })},
      ${admin}
    )
    RETURNING id, version
  `;
  await sql`INSERT INTO agent_credentials VALUES (${id}, ${encryptCredential(id, 'secret-eval')})`;
  await sql`UPDATE controls SET paused=false WHERE id=1`;
  return { id, v1, v2 };
}

test('replay comparison uses identical input against both configuration versions', async () => {
  const { id, v1, v2 } = await seedAgent();
  const input = 'Need a CRM that keeps follow-ups personal.';
  const saved = await saveEvaluationCase({
    actor: admin,
    agentId: id,
    title: 'Lead post',
    sourceKind: 'playground',
    caseInput: input,
    recipients: ['recipient-1'],
  });
  expect('caseId' in saved).toBe(true);
  if (!('caseId' in saved)) return;

  const started = await startEvaluationComparison({
    actor: admin,
    agentId: id,
    caseId: saved.caseId,
    leftConfigurationId: v1.id,
    rightConfigurationId: v2.id,
  });
  expect('comparisonId' in started).toBe(true);
  if (!('comparisonId' in started)) return;

  await processEvaluationReplayJob(
    { comparisonId: started.comparisonId, agentId: id, actor: admin },
    fixtureInference(),
  );

  const [comparison] = await sql`
    SELECT * FROM evaluation_comparisons WHERE id=${started.comparisonId}
  `;
  expect(comparison.status).toBe('completed');
  expect(comparison.left_run_id).toBeTruthy();
  expect(comparison.right_run_id).toBeTruthy();

  const runs = await sql`
    SELECT id, input, origin, configuration_id, status, result, recipients
    FROM simulation_runs
    WHERE id IN (${comparison.left_run_id}, ${comparison.right_run_id})
    ORDER BY configuration_id
  `;
  expect(runs).toHaveLength(2);
  expect(new Set(runs.map((run) => run.input))).toEqual(new Set([input]));
  expect(runs.every((run) => run.origin === 'replay')).toBe(true);
  expect(runs.every((run) => run.status === 'completed')).toBe(true);
  expect(new Set(runs.map((run) => run.configuration_id))).toEqual(new Set([v1.id, v2.id]));
  expect(runs.every((run) => JSON.stringify(run.recipients).includes('recipient-1'))).toBe(true);

  // Results survive a fresh read (reload).
  const [reloaded] = await sql`
    SELECT status, left_run_id, right_run_id FROM evaluation_comparisons WHERE id=${started.comparisonId}
  `;
  expect(reloaded.status).toBe('completed');
  expect(reloaded.left_run_id).toBe(comparison.left_run_id);
  expect(reloaded.right_run_id).toBe(comparison.right_run_id);
});

test('replay runs cannot dispatch an external write through the policy gateway', async () => {
  const { id, v1 } = await seedAgent();
  const [run] = await sql`
    INSERT INTO simulation_runs(
      agent_id, configuration_id, origin, input, status, result, actor, expires_at, execution_token
    )
    VALUES (
      ${id},
      ${v1.id},
      'replay',
      'fixture',
      'running',
      ${sql.json({ steps: [], actions: [], error: null })},
      ${admin},
      now() + interval '10 minutes',
      ${randomUUID()}
    )
    RETURNING id, execution_token
  `;

  const ctx = await loadPolicyContext(id, admin, run.id);
  expect(ctx?.executionContext).toBe('replay');

  const decision = await authorizeAction(ctx!, {
    type: 'reply',
    idempotencyKey: `replay-dispatch-${run.id}`,
    executionToken: run.execution_token,
    payload: { draft: 'Would send externally' },
  });
  expect(decision.decision).toBe('suppressed');
  expect(decision.reasons.join(' ')).toContain('Replay');

  // Structural outbound gate used by future adapters.
  expect(
    authorizeOutboundDispatch({
      executionContext: 'replay',
      lifecycle: 'live',
      adapterAvailable: true,
    }).allowed,
  ).toBe(false);

  const [intent] = await sql`
    SELECT decision FROM action_intents WHERE run_id=${run.id} ORDER BY created_at DESC LIMIT 1
  `;
  expect(intent.decision).toBe('suppressed');
});

test('retry reuses each side run instead of admitting duplicates', async () => {
  const { id, v1, v2 } = await seedAgent();
  const saved = await saveEvaluationCase({
    actor: admin,
    agentId: id,
    title: 'Retry case',
    sourceKind: 'playground',
    caseInput: 'Same lead twice.',
  });
  expect('caseId' in saved).toBe(true);
  if (!('caseId' in saved)) return;

  const started = await startEvaluationComparison({
    actor: admin,
    agentId: id,
    caseId: saved.caseId,
    leftConfigurationId: v1.id,
    rightConfigurationId: v2.id,
  });
  expect('comparisonId' in started).toBe(true);
  if (!('comparisonId' in started)) return;

  await processEvaluationReplayJob(
    { comparisonId: started.comparisonId, agentId: id, actor: admin },
    fixtureInference(),
  );

  const [first] = await sql`
    SELECT left_run_id, right_run_id FROM evaluation_comparisons WHERE id=${started.comparisonId}
  `;
  expect(first.left_run_id).toBeTruthy();
  expect(first.right_run_id).toBeTruthy();

  // Simulate a retryable failure after the left side finished: keep the comparison
  // running (terminal failed is cancel/exhaust only), fail the right run, then re-enter.
  await sql`
    UPDATE evaluation_comparisons
    SET status='running', error='infrastructure blip', finished_at=null
    WHERE id=${started.comparisonId}
  `;
  await sql`
    UPDATE simulation_runs
    SET status='failed', finished_at=now(), defer_reason='infrastructure blip'
    WHERE id=${first.right_run_id}
  `;

  await processEvaluationReplayJob(
    { comparisonId: started.comparisonId, agentId: id, actor: admin },
    fixtureInference(),
  );

  const [again] = await sql`
    SELECT status, left_run_id, right_run_id FROM evaluation_comparisons WHERE id=${started.comparisonId}
  `;
  expect(again.status).toBe('completed');
  expect(again.left_run_id).toBe(first.left_run_id);
  expect(again.right_run_id).toBe(first.right_run_id);

  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM simulation_runs WHERE agent_id=${id} AND origin='replay'
  `;
  expect(n).toBe(2);
});

test('demo Sarah email case seed is a structured drafting snapshot', () => {
  // knowledge.search replay parses case input as JSON; plain text would throw before inference.
  expect(emailKnowledgeQuery(DEMO_SARAH_EMAIL_CASE_INPUT)).toContain('invoices');
});

test('email case saves structured drafting snapshot and uses email semantics', async () => {
  const { id, v1, v2 } = await seedAgent();
  const threadId = randomUUID();
  await sql`
    INSERT INTO email_threads(id, agent_id, provisional)
    VALUES (${threadId}, ${id}, false)
  `;
  const [message] = await sql`
    INSERT INTO email_messages(
      agent_id, resend_email_id, event, sender, subject, received_at, thread_id, body
    )
    VALUES (
      ${id},
      ${`resend-${randomUUID()}`},
      ${sql.json({})},
      ${'lead@example.com'},
      ${'Pricing'},
      now(),
      ${threadId},
      ${'Can you send pricing?'}
    )
    RETURNING id
  `;

  const saved = await saveEvaluationCase({
    actor: admin,
    agentId: id,
    title: 'Inbound lead mail',
    sourceKind: 'email',
    sourceEmailMessageId: message.id,
    // Client may send a plain body; server must persist the production JSON snapshot.
    caseInput: 'Can you send pricing?',
  });
  expect('caseId' in saved).toBe(true);
  if (!('caseId' in saved)) return;

  const [caseRow] = await sql`SELECT input FROM evaluation_cases WHERE id=${saved.caseId}`;
  const snapshot = JSON.parse(caseRow.input as string) as {
    currentMessage: { subject: string; body: string; sender: string };
  };
  expect(snapshot.currentMessage).toEqual({
    subject: 'Pricing',
    body: 'Can you send pricing?',
    sender: 'lead@example.com',
  });

  const started = await startEvaluationComparison({
    actor: admin,
    agentId: id,
    caseId: saved.caseId,
    leftConfigurationId: v1.id,
    rightConfigurationId: v2.id,
  });
  expect('comparisonId' in started).toBe(true);
  if (!('comparisonId' in started)) return;

  // Empty evaluator actions: playground would skip main without knowledge; email must still draft.
  const emailInference: (key: string) => ModelCall = () => async (request) => {
    if (request.stage === 'evaluator') {
      return {
        decision: {
          relevant: true,
          priority: 0.9,
          reason: 'Needs a reply',
          actions: [],
        },
        inputTokens: 2,
        outputTokens: 2,
        costMicros: 0,
      };
    }
    return {
      decision: {
        relevant: true,
        priority: 0.9,
        reason: 'Draft reply',
        actions: [],
        answer: 'Happy to share pricing — what company size are you?',
        citations: [],
      },
      inputTokens: 4,
      outputTokens: 6,
      costMicros: 0,
    };
  };

  await processEvaluationReplayJob(
    { comparisonId: started.comparisonId, agentId: id, actor: admin },
    emailInference,
  );

  const [comparison] = await sql`
    SELECT left_run_id, status FROM evaluation_comparisons WHERE id=${started.comparisonId}
  `;
  expect(comparison.status).toBe('completed');
  const [left] = await sql`
    SELECT origin, result FROM simulation_runs WHERE id=${comparison.left_run_id}
  `;
  expect(left.origin).toBe('replay');
  const stages = (left.result.steps as { stage: string }[]).map((step) => step.stage);
  expect(stages).toContain('evaluator');
  expect(stages).toContain('main');
  const draft = draftAnswerFromResult(left.result);
  expect(draft?.answer).toContain('pricing');
  // Uncited email drafts must still surface (groundedAnswerFromResult would be null).
  expect(draft?.sources).toEqual([]);
});

test('email case save rebuilds snapshot without requiring a short client body', async () => {
  const { id } = await seedAgent();
  const threadId = randomUUID();
  const longBody = `${'Please review. '.repeat(1200)}End.`;
  expect(longBody.length).toBeGreaterThan(16_000);
  await sql`
    INSERT INTO email_threads(id, agent_id, provisional)
    VALUES (${threadId}, ${id}, false)
  `;
  const [message] = await sql`
    INSERT INTO email_messages(
      agent_id, resend_email_id, event, sender, subject, received_at, thread_id, body
    )
    VALUES (
      ${id},
      ${`resend-${randomUUID()}`},
      ${sql.json({})},
      ${'lead@example.com'},
      ${'Long thread'},
      now(),
      ${threadId},
      ${longBody}
    )
    RETURNING id
  `;

  const saved = await saveEvaluationCase({
    actor: admin,
    agentId: id,
    title: 'Long inbound',
    sourceKind: 'email',
    sourceEmailMessageId: message.id,
    caseInput: '',
  });
  expect('caseId' in saved).toBe(true);
  if (!('caseId' in saved)) return;
  const [caseRow] = await sql`SELECT input FROM evaluation_cases WHERE id=${saved.caseId}`;
  const snapshot = JSON.parse(caseRow.input as string) as {
    currentMessage: { body: string };
  };
  expect(snapshot.currentMessage.body?.length).toBeLessThanOrEqual(8_000);
  expect(snapshot.currentMessage.body).toContain('Please review.');
});

test('cancelled evaluation jobs finalize open comparisons', async () => {
  const { id, v1, v2 } = await seedAgent();
  const saved = await saveEvaluationCase({
    actor: admin,
    agentId: id,
    title: 'Cancel case',
    sourceKind: 'playground',
    caseInput: 'Will be cancelled.',
  });
  expect('caseId' in saved).toBe(true);
  if (!('caseId' in saved)) return;

  const started = await startEvaluationComparison({
    actor: admin,
    agentId: id,
    caseId: saved.caseId,
    leftConfigurationId: v1.id,
    rightConfigurationId: v2.id,
  });
  expect('comparisonId' in started).toBe(true);
  if (!('comparisonId' in started)) return;

  await db().transaction(async (tx) => {
    await finalizeCancelledEvaluationComparisons(
      tx,
      [started.jobId],
      'Agent paused; queued comparison cancelled.',
    );
  });

  const [comparison] = await sql`
    SELECT status, error, job_id FROM evaluation_comparisons WHERE id=${started.comparisonId}
  `;
  expect(comparison.status).toBe('failed');
  expect(comparison.error).toContain('paused');
  expect(comparison.job_id).toBe(started.jobId);

  const [job] = await sql`SELECT type FROM jobs WHERE id=${started.jobId}`;
  expect(job.type).toBe(EVALUATION_REPLAY_JOB);
});

test('exhausted evaluation retries finalize linked non-terminal runs', async () => {
  const { id, v1, v2 } = await seedAgent();
  const saved = await saveEvaluationCase({
    actor: admin,
    agentId: id,
    title: 'Exhaust case',
    sourceKind: 'playground',
    caseInput: 'Stuck comparison.',
  });
  expect('caseId' in saved).toBe(true);
  if (!('caseId' in saved)) return;

  const started = await startEvaluationComparison({
    actor: admin,
    agentId: id,
    caseId: saved.caseId,
    leftConfigurationId: v1.id,
    rightConfigurationId: v2.id,
  });
  expect('comparisonId' in started).toBe(true);
  if (!('comparisonId' in started)) return;

  const [leftRun] = await sql`
    INSERT INTO simulation_runs(
      agent_id, configuration_id, origin, input, status, result, actor, expires_at
    )
    VALUES (
      ${id},
      ${v1.id},
      'replay',
      'Stuck comparison.',
      'running',
      ${sql.json({ steps: [], actions: [], error: null })},
      ${admin},
      now() + interval '10 minutes'
    )
    RETURNING id
  `;
  await sql`
    UPDATE evaluation_comparisons
    SET status='running', left_run_id=${leftRun.id}
    WHERE id=${started.comparisonId}
  `;

  await finalizeExhaustedEvaluationReplayJob(
    { comparisonId: started.comparisonId },
    'lease expired',
  );

  const [comparison] = await sql`
    SELECT status, error FROM evaluation_comparisons WHERE id=${started.comparisonId}
  `;
  expect(comparison.status).toBe('failed');
  expect(comparison.error).toContain('retries exhausted');

  const [run] = await sql`
    SELECT status, defer_reason FROM simulation_runs WHERE id=${leftRun.id}
  `;
  expect(run.status).toBe('failed');
  expect(run.defer_reason).toContain('retries exhausted');
});

test('reconcile finalizes open comparisons linked to dead evaluation jobs', async () => {
  const { id, v1, v2 } = await seedAgent();
  const saved = await saveEvaluationCase({
    actor: admin,
    agentId: id,
    title: 'Dead-letter reconcile',
    sourceKind: 'playground',
    caseInput: 'Orphaned after finalize blip.',
  });
  expect('caseId' in saved).toBe(true);
  if (!('caseId' in saved)) return;

  const started = await startEvaluationComparison({
    actor: admin,
    agentId: id,
    caseId: saved.caseId,
    leftConfigurationId: v1.id,
    rightConfigurationId: v2.id,
  });
  expect('comparisonId' in started).toBe(true);
  if (!('comparisonId' in started)) return;

  const [leftRun] = await sql`
    INSERT INTO simulation_runs(
      agent_id, configuration_id, origin, input, status, result, actor, expires_at
    )
    VALUES (
      ${id},
      ${v1.id},
      'replay',
      'Orphaned after finalize blip.',
      'running',
      ${sql.json({ steps: [], actions: [], error: null })},
      ${admin},
      now() + interval '10 minutes'
    )
    RETURNING id
  `;
  await sql`
    UPDATE evaluation_comparisons
    SET status='running', left_run_id=${leftRun.id}
    WHERE id=${started.comparisonId}
  `;
  // Simulate worker exit after dead-lettering the job but before onDeadLetter finalize.
  await sql`
    UPDATE jobs
    SET status='dead', finished_at=now(), last_error='lease expired after max attempts',
        claimed_by=null, claimed_at=null, claim_expires_at=null
    WHERE id=${started.jobId}
  `;

  await reconcileDeadEvaluationReplayJobs();

  const [comparison] = await sql`
    SELECT status, error FROM evaluation_comparisons WHERE id=${started.comparisonId}
  `;
  expect(comparison.status).toBe('failed');
  expect(String(comparison.error)).toContain('retries exhausted');

  const [run] = await sql`
    SELECT status, defer_reason FROM simulation_runs WHERE id=${leftRun.id}
  `;
  expect(run.status).toBe('failed');
  expect(String(run.defer_reason)).toContain('retries exhausted');

  // Idempotent on a second tick.
  await reconcileDeadEvaluationReplayJobs();
  const [again] = await sql`
    SELECT status FROM evaluation_comparisons WHERE id=${started.comparisonId}
  `;
  expect(again.status).toBe('failed');
});

test('stop during claimed replay admission cancels without deadlock', async () => {
  const { id, v1, v2 } = await seedAgent();
  const saved = await saveEvaluationCase({
    actor: admin,
    agentId: id,
    title: 'Stop during admit',
    sourceKind: 'playground',
    caseInput: 'Race stop against admission.',
  });
  expect('caseId' in saved).toBe(true);
  if (!('caseId' in saved)) return;

  const started = await startEvaluationComparison({
    actor: admin,
    agentId: id,
    caseId: saved.caseId,
    leftConfigurationId: v1.id,
    rightConfigurationId: v2.id,
  });
  expect('comparisonId' in started).toBe(true);
  if (!('comparisonId' in started)) return;

  const workerId = `eval-lock-${randomUUID()}`;
  // Claim this comparison's job directly so leftover pending evaluation.replay rows cannot steal it.
  const [claimed] = await sql`
    UPDATE jobs
    SET
      status='claimed',
      claimed_by=${workerId},
      claimed_at=now(),
      claim_expires_at=now() + interval '2 minutes',
      attempts=greatest(attempts, 1),
      updated_at=now()
    WHERE id=${started.jobId} AND status='pending'
    RETURNING id
  `;
  expect(claimed?.id).toBe(started.jobId);

  const claim = {
    jobId: started.jobId,
    workerId,
    jobType: EVALUATION_REPLAY_JOB,
  };

  // Flip lifecycle first so admission cannot succeed; then race cancel against the claimed worker.
  // Both paths take agent → job → comparison locks — a timeout here means inversion/deadlock.
  await sql`UPDATE agents SET lifecycle='stopped' WHERE id=${id}`;
  const raced = Promise.all([
    cancelWorkForLifecycle(id, 'stopped'),
    processEvaluationReplayJob(
      { comparisonId: started.comparisonId, agentId: id, actor: admin },
      fixtureInference(),
      undefined,
      claim,
    ).catch((error: unknown) => error),
  ]);
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error('Deadlock suspected: stop vs replay admission timed out')),
      8_000,
    );
  });
  const [cancelledIds] = await Promise.race([raced, timeout]);

  expect(cancelledIds).toContain(started.jobId);

  const [comparison] = await sql`
    SELECT status, error FROM evaluation_comparisons WHERE id=${started.comparisonId}
  `;
  expect(comparison.status).toBe('failed');
  expect(String(comparison.error ?? '')).toContain('stopped');

  const [job] = await sql`SELECT status FROM jobs WHERE id=${started.jobId}`;
  expect(job.status).toBe('cancelled');
});
