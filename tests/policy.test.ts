import { expect, test } from 'bun:test';

import { budgetDefaults } from '@/lib/budgets';
import { evaluateActionForTest } from '@/lib/policy/gateway';

const base = {
  lifecycle: 'shadow' as const,
  enabledTools: [] as string[],
  budgets: budgetDefaults,
  globalPaused: false,
};

test('policy gateway denies global pause', () => {
  const result = evaluateActionForTest(
    { ...base, globalPaused: true },
    { type: 'reply', idempotencyKey: 'k1' },
  );
  expect(result.decision).toBe('deny');
  expect(result.reasons.join(' ')).toContain('Global outbound pause');
});

test('policy gateway denies stopped and paused agents', () => {
  expect(
    evaluateActionForTest(
      { ...base, lifecycle: 'stopped' },
      { type: 'reply', idempotencyKey: 'k2' },
    ).decision,
  ).toBe('deny');
  expect(
    evaluateActionForTest({ ...base, lifecycle: 'paused' }, { type: 'reply', idempotencyKey: 'k3' })
      .decision,
  ).toBe('deny');
});

test('policy gateway denies tools that are not enabled', () => {
  const result = evaluateActionForTest(
    { ...base, enabledTools: ['like'] },
    { type: 'reply', idempotencyKey: 'k4' },
  );
  expect(result.decision).toBe('deny');
  expect(result.reasons.join(' ')).toContain('not enabled');
});

test('policy gateway denies outbound budget exhaustion', () => {
  const result = evaluateActionForTest(
    {
      ...base,
      budgets: { ...budgetDefaults, dailyOutboundActions: 0 },
    },
    { type: 'reply', idempotencyKey: 'k5' },
  );
  expect(result.decision).toBe('deny');
  expect(result.violation).toBe('daily-outbound');
});

test('shadow and live suppress writes when adapters are absent', () => {
  expect(evaluateActionForTest(base, { type: 'reply', idempotencyKey: 'k6' }).decision).toBe(
    'suppressed',
  );
  expect(
    evaluateActionForTest({ ...base, lifecycle: 'live' }, { type: 'reply', idempotencyKey: 'k7' })
      .decision,
  ).toBe('suppressed');
});

test('read-only tools can allow when budgets permit', () => {
  const result = evaluateActionForTest(base, {
    type: 'knowledge.search',
    idempotencyKey: 'k8',
    readOnly: true,
  });
  expect(result.decision).toBe('allow');
});

test('approval rules are disabled by default for ordinary writes', () => {
  const result = evaluateActionForTest(
    { ...base, approvalTools: [] },
    { type: 'reply', idempotencyKey: 'k9' },
  );
  expect(result.decision).toBe('suppressed');
});

test('configured approval tools return needs-approval', () => {
  const result = evaluateActionForTest(
    { ...base, approvalTools: ['reply'] },
    { type: 'reply', idempotencyKey: 'k10' },
  );
  expect(result.decision).toBe('needs-approval');
});

test('introduce still needs approval without configured tools', () => {
  const result = evaluateActionForTest(
    { ...base, approvalTools: [] },
    { type: 'introduce', idempotencyKey: 'k11' },
  );
  expect(result.decision).toBe('needs-approval');
});

test('preliminary evaluator proposals skip needs-approval', () => {
  const result = evaluateActionForTest(
    { ...base, approvalTools: ['reply'] },
    { type: 'reply', idempotencyKey: 'k12', preliminary: true },
  );
  expect(result.decision).toBe('suppressed');
});

test('spend threshold can require approval', () => {
  const result = evaluateActionForTest(
    {
      ...base,
      approvalTools: [],
      approvalSpendCents: 10,
      usage: {
        spendMicros: BigInt(10 * 10_000),
        requests: 1,
        outboundActions: 0,
        month: { spendMicros: BigInt(0), requests: 0, outboundActions: 0 },
        activeRuns: 0,
      },
    },
    { type: 'reply', idempotencyKey: 'k13' },
  );
  expect(result.decision).toBe('needs-approval');
});
