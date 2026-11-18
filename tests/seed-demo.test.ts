import { describe, expect, test } from 'bun:test';

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
import { demoAgents, demoConfigurations, demoConsents, demoRuns } from '@/lib/seed/catalog';

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

  test('runs include succeeded, failed and interrupted with tool steps', () => {
    const runs = demoRuns();
    const statuses = new Set(runs.map((run) => run.status));
    expect(statuses).toEqual(new Set(['completed', 'failed', 'interrupted']));
    expect(runs.some((run) => run.result.steps.length >= 2)).toBe(true);
    expect(runs.some((run) => run.result.error)).toBe(true);
    expect(runs.every((run) => run.id.startsWith('00000000-0000-4000-a200-'))).toBe(true);
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
    expect(names).toContain('usage');
    expect(names).toContain('credentials');
  });
});
