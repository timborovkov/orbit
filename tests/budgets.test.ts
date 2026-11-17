import { expect, test } from 'bun:test';

import {
  budgetDefaults,
  budgetsSchema,
  checkOutboundBudgets,
  checkRequestBudgets,
  checkRunDeadline,
  checkToolStepLimit,
  estimateSpendMicros,
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
  expect(checkToolStepLimit(10, budgetDefaults)).toBe('tool-steps');
  expect(checkToolStepLimit(9, budgetDefaults)).toBeNull();
  const started = new Date('2026-01-01T00:00:00Z');
  expect(checkRunDeadline(started, new Date('2026-01-01T00:05:00Z'), budgetDefaults)).toBe(
    'run-deadline',
  );
  expect(checkRunDeadline(started, new Date('2026-01-01T00:04:59Z'), budgetDefaults)).toBeNull();
});

test('spend estimation documents zero when pricing unavailable', () => {
  expect(estimateSpendMicros(100, 50)).toBe(0);
  expect(estimateSpendMicros(100, 50, 12)).toBe(1800n);
});
