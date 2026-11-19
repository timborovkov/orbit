import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import postgres from 'postgres';

import { budgetDefaults } from '@/lib/budgets';
import { closeDb } from '@/lib/db';
import { authorizeAction, loadPolicyContext } from '@/lib/policy/gateway';
import { authorizeOutboundDispatch } from '@/lib/policy/outbound';
import {
  processEvaluationReplayJob,
  saveEvaluationCase,
  startEvaluationComparison,
} from '@/lib/runtime/evaluation';
import { encryptCredential } from '@/lib/runtime/secrets';
import type { ModelCall } from '@/lib/runtime/simulation';

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
