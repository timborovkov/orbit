import { expect, test } from 'bun:test';

import {
  budgetDefaults,
  BudgetError,
  budgetsSchema,
  checkOutboundBudgets,
  checkRequestBudgets,
  checkRunDeadline,
  checkToolStepLimit,
  isBudgetError,
  isTrustedBudgetMessage,
  parseBudgets,
} from '@/lib/budgets';

test('defaults match architecture section 17', () => {
  expect(budgetDefaults.maxToolStepsPerRun).toBe(10);
  expect(budgetDefaults.runDeadlineSeconds).toBe(300);
  expect(budgetsSchema.parse(budgetDefaults)).toEqual(budgetDefaults);
});

test('request and outbound budget violations', () => {
  const budgets = parseBudgets({
    ...budgetDefaults,
    dailyRequests: 2,
    monthlyRequests: 10,
    dailyOutboundActions: 1,
    monthlyOutboundActions: 5,
    maxConcurrentRuns: 1,
  });
  expect(
    checkRequestBudgets({
      budgets,
      day: { spendMicros: 0n, requests: 2, outboundActions: 0 },
      month: { spendMicros: 0n, requests: 2, outboundActions: 0 },
      activeRuns: 0,
    }),
  ).toBe('daily-requests');
  expect(
    checkRequestBudgets({
      budgets,
      day: { spendMicros: 0n, requests: 0, outboundActions: 0 },
      month: { spendMicros: 0n, requests: 0, outboundActions: 0 },
      activeRuns: 1,
    }),
  ).toBe('concurrency');
  expect(
    checkOutboundBudgets({
      budgets,
      day: { spendMicros: 0n, requests: 0, outboundActions: 1 },
      month: { spendMicros: 0n, requests: 0, outboundActions: 1 },
      activeRuns: 0,
    }),
  ).toBe('daily-outbound');
});

test('tool step and deadline limits', () => {
  expect(checkToolStepLimit(10, budgetDefaults)).toBeNull();
  expect(checkToolStepLimit(11, budgetDefaults)).toBe('tool-steps');
  expect(checkToolStepLimit(9, budgetDefaults)).toBeNull();
  const started = new Date('2026-01-01T00:00:00Z');
  expect(checkRunDeadline(started, new Date('2026-01-01T00:05:00Z'), budgetDefaults)).toBe(
    'run-deadline',
  );
  expect(checkRunDeadline(started, new Date('2026-01-01T00:04:59Z'), budgetDefaults)).toBeNull();
});

test('spend caps are independent and accept an explicit no-cap setting', () => {
  const day = { spendMicros: 80_000n, requests: 0, outboundActions: 0 };
  const month = { ...day, spendMicros: 8_000n };
  const budgets = parseBudgets({ dailySpendCents: null, monthlySpendCents: 1 });
  const snapshot = { budgets, day, month, activeRuns: 0 };
  expect(checkRequestBudgets(snapshot, 2_000n)).toBeNull();
  expect(checkRequestBudgets(snapshot, 2_001n)).toBe('monthly-spend');
  expect(checkRequestBudgets({ ...snapshot, budgets: { ...budgets, dailySpendCents: 0 } })).toBe(
    'daily-spend',
  );
});

test('BudgetError messages are exact trusted allowlist entries', () => {
  const error = new BudgetError('daily-requests');
  expect(isBudgetError(error)).toBe(true);
  expect(isTrustedBudgetMessage(error.message)).toBe(true);
  expect(isTrustedBudgetMessage('Provider deadline exceeded; Authorization: Bearer secret')).toBe(
    false,
  );
  expect(isBudgetError(new Error(error.message))).toBe(false);
});
