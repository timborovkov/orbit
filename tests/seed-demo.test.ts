import { describe, expect, test } from 'bun:test';

import { actionIdempotencyKey } from '@/lib/runtime/action-idempotency';
import {
  assertSafeToSeed,
  DEMO_ACTOR,
  DEMO_AGENT_IDS,
  DEMO_AGENTS,
  demoPlanFingerprint,
  isDemoAgentId,
  isLocalDatabaseUrl,
  listSeedModuleNames,
} from '@/lib/seed';
import {
  DEMO_SARAH_SUSPENDED_ESCALATE,
  demoAgents,
  demoConfigurations,
  demoConsents,
  demoKnowledgeDocuments,
  demoRuns,
  demoSarahSuspendedEscalateKey,
} from '@/lib/seed/catalog';
import { DEMO_CONFIGS, DEMO_JOBS, DEMO_RUNS } from '@/lib/seed/ids';
import { isDemoOwnedJob } from '@/lib/seed/reset';

describe('demo seed guards', () => {
  test('accepts loopback development databases', () => {
    expect(
      assertSafeToSeed({
        nodeEnv: 'development',
        databaseUrl: 'postgres://orbit:orbit_dev@127.0.0.1:5432/orbit',
        allowNonLocal: false,
      }),
    ).toEqual({ ok: true });
    expect(
      assertSafeToSeed({
        nodeEnv: 'test',
        databaseUrl: 'postgres://orbit:orbit_dev@localhost:5432/orbit',
        allowNonLocal: false,
      }),
    ).toEqual({ ok: true });
    expect(isLocalDatabaseUrl('postgres://orbit:orbit_dev@[::1]:5432/orbit')).toBe(true);
  });

  test('refuses production regardless of override', () => {
    const result = assertSafeToSeed({
      nodeEnv: 'production',
      databaseUrl: 'postgres://orbit:orbit_dev@127.0.0.1:5432/orbit',
      allowNonLocal: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('NODE_ENV=production');
  });

  test('refuses non-local databases without override', () => {
    const blocked = assertSafeToSeed({
      nodeEnv: 'development',
      databaseUrl: 'postgres://orbit:orbit_dev@db.example.com:5432/orbit',
      allowNonLocal: false,
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain('loopback');

    expect(
      assertSafeToSeed({
        nodeEnv: 'development',
        databaseUrl: 'postgres://orbit:orbit_dev@db.example.com:5432/orbit',
        allowNonLocal: true,
      }),
    ).toEqual({ ok: true });
  });

  test('refuses missing DATABASE_URL', () => {
    const result = assertSafeToSeed({
      nodeEnv: 'development',
      databaseUrl: undefined,
      allowNonLocal: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('DATABASE_URL');
  });

  test('rejects invalid database URLs as non-local', () => {
    expect(isLocalDatabaseUrl('not-a-url')).toBe(false);
  });
});

describe('demo seed idempotency and markers', () => {
  test('fixed demo agent IDs are stable markers', () => {
    expect(DEMO_AGENTS.john).toBe('00000000-0000-4000-a000-000000000001');
    expect(DEMO_AGENTS.sarah).toBe('00000000-0000-4000-a000-000000000002');
    expect(DEMO_AGENTS.maya).toBe('00000000-0000-4000-a000-000000000003');
    expect(DEMO_AGENT_IDS).toHaveLength(3);
    expect(isDemoAgentId(DEMO_AGENTS.john)).toBe(true);
    expect(isDemoAgentId('11111111-1111-4111-a111-111111111111')).toBe(false);
    expect(DEMO_ACTOR).toBe('orbit-demo-seed');
  });

  test('catalog fingerprint is deterministic for the same now', () => {
    const now = new Date('2026-06-15T12:00:00.000Z');
    expect(demoPlanFingerprint(now)).toBe(demoPlanFingerprint(now));
    expect(demoPlanFingerprint(now)).not.toBe(
      demoPlanFingerprint(new Date('2026-06-16T12:00:00.000Z')),
    );
  });

  test('agents cover templates and lifecycle mix', () => {
    const agents = demoAgents();
    expect(agents.map((agent) => agent.name)).toEqual(['John', 'Sarah', 'Maya']);
    expect(agents.map((agent) => agent.templateId)).toEqual(['sales', 'support', 'superconnector']);
    expect(agents.map((agent) => agent.lifecycle).sort()).toEqual(['live', 'paused', 'shadow']);
    expect(agents.some((agent) => agent.fakeOpenRouterKey?.includes('demo'))).toBe(true);
  });

  test('runs include succeeded, failed, interrupted and awaiting_approval', () => {
    const runs = demoRuns();
    const statuses = new Set(runs.map((run) => run.status));
    expect(statuses).toEqual(new Set(['completed', 'failed', 'interrupted', 'awaiting_approval']));
    expect(runs.some((run) => run.result.steps.length >= 2)).toBe(true);
    expect(runs.some((run) => run.result.error)).toBe(true);
    expect(runs.some((run) => run.status === 'awaiting_approval' && run.deferReason)).toBe(true);
    expect(runs.every((run) => run.id.startsWith('00000000-0000-4000-a200-'))).toBe(true);
  });

  test('agents and configurations carry durable approval settings', () => {
    const sarah = demoAgents().find((agent) => agent.id === DEMO_AGENTS.sarah);
    expect(sarah?.approvalExpiresAfterHours).toBe(48);
    expect(sarah?.approvalOnReject).toBe('continue');
    expect(sarah?.approvalSpendCents).toBe(2_500);
    expect(sarah?.enabledTools).toContain('knowledge.search');

    const configs = demoConfigurations();
    expect(configs.every((row) => row.approvalSettings)).toBe(true);
    expect(
      configs.find((row) => row.id === DEMO_CONFIGS.sarahV2)?.approvalSettings.approvalTools,
    ).toEqual(['escalate']);
  });

  test('knowledge documents include ready chunks and a failed upload', () => {
    const docs = demoKnowledgeDocuments();
    expect(docs.length).toBeGreaterThanOrEqual(3);
    expect(docs.some((doc) => doc.status === 'ready' && doc.chunks.length >= 2)).toBe(true);
    expect(docs.some((doc) => doc.status === 'failed' && doc.error)).toBe(true);
    expect(docs.every((doc) => doc.id.startsWith('00000000-0000-4000-a700-'))).toBe(true);
  });

  test('configuration versions and consents are present', () => {
    expect(demoConfigurations().length).toBeGreaterThanOrEqual(5);
    expect(demoConfigurations().filter((row) => row.agentId === DEMO_AGENTS.john)).toHaveLength(2);
    expect(demoConsents().some((row) => row.scope === 'introduce' && row.granted)).toBe(true);
    expect(demoConsents().some((row) => row.scope === 'escalate' && !row.granted)).toBe(true);
  });

  test('registry lists modular feature areas for extension', () => {
    const names = listSeedModuleNames();
    expect(names).toContain('agents');
    expect(names).toContain('configurations');
    expect(names).toContain('runs');
    expect(names).toContain('consents');
    expect(names).toContain('approvals');
    expect(names).toContain('knowledge');
    expect(names).toContain('usage');
    expect(names).toContain('credentials');
    expect(names).toContain('controls');
    expect(names).toContain('discovery');
  });
});

describe('demo seed suspended approval key', () => {
  test('matches the runtime action idempotency formula for Sarah’s escalate', () => {
    const run = demoRuns().find((row) => row.id === DEMO_RUNS.sarahAwaitingApproval);
    expect(run).toBeDefined();
    const mainEscalate = run?.result.steps
      .find((step) => step.stage === 'main')
      ?.decision.actions.find((action) => action.type === 'escalate');
    expect(mainEscalate?.reason).toBe(DEMO_SARAH_SUSPENDED_ESCALATE.reason);
    expect(demoSarahSuspendedEscalateKey()).toBe(
      actionIdempotencyKey({
        runId: DEMO_RUNS.sarahAwaitingApproval,
        stage: 'main',
        actionType: 'escalate',
        index: 0,
        reason: DEMO_SARAH_SUSPENDED_ESCALATE.reason,
      }),
    );
    expect(demoSarahSuspendedEscalateKey()).toMatch(/^[a-f0-9]{64}$/);
    expect(demoSarahSuspendedEscalateKey()).not.toContain('orbit-demo:');
  });
});

describe('demo seed reset job ownership', () => {
  test('includes runtime resume jobs for demo runs regardless of key prefix', () => {
    const resumeKey = `simulation:${DEMO_RUNS.sarahAwaitingApproval}:resume:${DEMO_JOBS.sarahAwaitingApproval}`;
    expect(
      isDemoOwnedJob({
        id: '11111111-1111-4111-a111-111111111111',
        idempotencyKey: resumeKey,
        payload: {
          runId: DEMO_RUNS.sarahAwaitingApproval,
          agentId: DEMO_AGENTS.sarah,
        },
      }),
    ).toBe(true);

    expect(
      isDemoOwnedJob({
        id: '11111111-1111-4111-a111-111111111112',
        idempotencyKey: `simulation:${DEMO_RUNS.sarahAwaitingApproval}`,
        payload: { runId: DEMO_RUNS.sarahAwaitingApproval, agentId: DEMO_AGENTS.sarah },
      }),
    ).toBe(true);

    expect(
      isDemoOwnedJob({
        id: DEMO_JOBS.sarahAwaitingApproval,
        idempotencyKey: `orbit-demo:run:${DEMO_RUNS.sarahAwaitingApproval}`,
        payload: { runId: DEMO_RUNS.sarahAwaitingApproval, agentId: DEMO_AGENTS.sarah },
      }),
    ).toBe(true);
  });

  test('excludes unrelated agents and runs', () => {
    const otherRun = '11111111-1111-4111-b111-111111111111';
    const otherAgent = '11111111-1111-4111-b111-111111111222';
    expect(
      isDemoOwnedJob({
        id: '11111111-1111-4111-a111-111111111113',
        idempotencyKey: `simulation:${otherRun}:resume:initial`,
        payload: { runId: otherRun, agentId: otherAgent },
      }),
    ).toBe(false);
  });
});

describe('demo seed global pause', () => {
  test('controls module leaves pause untouched without explicit opt-in', async () => {
    const updates: Array<{ paused: boolean }> = [];
    const tx = {
      update: () => ({
        set: (values: { paused: boolean }) => {
          updates.push(values);
          return {
            where: async () => undefined,
          };
        },
      }),
    };
    const { controlsModule } = await import('@/lib/seed/modules/controls');
    await controlsModule.apply({
      db: {} as never,
      tx: tx as never,
      now: new Date(),
      reset: false,
      encryptionKeyConfigured: false,
      releaseGlobalPause: false,
    });
    expect(updates).toEqual([]);

    await controlsModule.apply({
      db: {} as never,
      tx: tx as never,
      now: new Date(),
      reset: false,
      encryptionKeyConfigured: false,
      releaseGlobalPause: true,
    });
    expect(updates).toEqual([{ paused: false }]);
  });
});
