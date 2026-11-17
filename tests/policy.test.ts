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
    evaluateActionForTest({ ...base, lifecycle: 'stopped' }, { type: 'reply', idempotencyKey: 'k2' })
      .decision,
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
  expect(
    evaluateActionForTest(base, { type: 'reply', idempotencyKey: 'k6' }).decision,
  ).toBe('suppressed');
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
