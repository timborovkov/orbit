import { expect, test } from 'bun:test';

import {
  centsToDollarsInput,
  dollarsInputToCents,
  formatCapDollars,
  formatSpendDollars,
  spendCapCentsFromForm,
} from '@/lib/budget-money';
import {
  budgetDefaults,
  BudgetError,
  budgetNoCapAriaLabel,
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
  expect(checkRequestBudgets(snapshot, 2_001n)).toBe('monthly-spend-reservation');
  expect(checkRequestBudgets({ ...snapshot, budgets: { ...budgets, dailySpendCents: 0 } })).toBe(
    'daily-spend',
  );
  expect(
    checkRequestBudgets(
      {
        ...snapshot,
        day: { ...day, spendMicros: 6_000n },
        budgets: { ...budgets, dailySpendCents: 1, monthlySpendCents: null },
      },
      39_000n,
    ),
  ).toBe('daily-spend-reservation');
  // In-run tools may ignore spend that an admitted reservation already filled.
  expect(
    checkRequestBudgets(
      {
        ...snapshot,
        day: { ...day, spendMicros: 10_000n },
        budgets: { ...budgets, dailySpendCents: 1, monthlySpendCents: null },
      },
      0n,
      0,
      { checkSpend: false },
    ),
  ).toBeNull();
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

test('spend-cap No cap switches keep distinct accessible names', () => {
  expect(budgetNoCapAriaLabel('dailySpendCents')).toBe('No cap for daily spend');
  expect(budgetNoCapAriaLabel('monthlySpendCents')).toBe('No cap for monthly spend');
  expect(budgetNoCapAriaLabel('dailySpendCents')).not.toBe(
    budgetNoCapAriaLabel('monthlySpendCents'),
  );
});

test('cents convert to dollar input values', () => {
  expect(centsToDollarsInput(500)).toBe('5.00');
  expect(centsToDollarsInput(450)).toBe('4.50');
  expect(centsToDollarsInput(5)).toBe('0.05');
  expect(centsToDollarsInput(0)).toBe('0.00');
  expect(centsToDollarsInput(null)).toBe('');
  expect(centsToDollarsInput(-1)).toBe('');
  expect(centsToDollarsInput(1.5)).toBe('');
  expect(formatCapDollars(5000)).toBe('$50.00');
  expect(formatCapDollars(null)).toBe('No cap');
});

test('dollar input converts to whole cents with half-up rounding', () => {
  expect(dollarsInputToCents('5')).toBe(500);
  expect(dollarsInputToCents('4.5')).toBe(450);
  expect(dollarsInputToCents('0.07')).toBe(7);
  expect(dollarsInputToCents('.5')).toBe(50);
  expect(dollarsInputToCents('5.')).toBe(500);
  expect(dollarsInputToCents(' $1,234.56 ')).toBe(123_456);
  expect(dollarsInputToCents('1.005')).toBe(101);
  expect(dollarsInputToCents('1.004')).toBe(100);
  expect(dollarsInputToCents('0.999')).toBe(100);
  expect(dollarsInputToCents('19.995')).toBe(2000);
  expect(dollarsInputToCents('0')).toBe(0);
  expect(dollarsInputToCents('10000')).toBe(1_000_000);
});

test('invalid dollar input is undefined, never silently unlimited', () => {
  for (const value of ['', '  ', '.', '$', '-1', 'abc', '1e3', '1.2.3', '1,23', null, undefined]) {
    expect(dollarsInputToCents(value)).toBeUndefined();
  }
  expect(dollarsInputToCents('9'.repeat(40))).toBeUndefined();
});

test('spend form values map to schema input and round-trip through cents', () => {
  expect(spendCapCentsFromForm(null, 'on')).toBeNull();
  expect(spendCapCentsFromForm('12', 'on')).toBeNull();
  expect(spendCapCentsFromForm('12.34', null)).toBe(1234);
  expect(spendCapCentsFromForm('', null)).toBeUndefined();
  expect(spendCapCentsFromForm(null, null)).toBeUndefined();
  for (const cents of [0, 1, 99, 100, 450, 5000, 1_000_000]) {
    expect(dollarsInputToCents(centsToDollarsInput(cents))).toBe(cents);
  }
  const over = spendCapCentsFromForm('10001', null);
  expect(budgetsSchema.safeParse({ ...budgetDefaults, dailySpendCents: over }).success).toBe(false);
  expect(
    budgetsSchema.parse({ ...budgetDefaults, dailySpendCents: spendCapCentsFromForm('5', null) })
      .dailySpendCents,
  ).toBe(500);
});

test('spend micros format as dollars', () => {
  expect(formatSpendDollars(0n)).toBe('$0.00');
  expect(formatSpendDollars(-5n)).toBe('$0.00');
  expect(formatSpendDollars(10_000n)).toBe('$0.01');
  expect(formatSpendDollars(5_000_000n)).toBe('$5.00');
  expect(formatSpendDollars(123_450_000n)).toBe('$123.45');
  expect(formatSpendDollars(12_345n)).toBe('$0.0123');
  expect(formatSpendDollars(12_350n)).toBe('$0.0124');
  expect(formatSpendDollars(10_500n)).toBe('$0.0105');
  expect(formatSpendDollars(1_500n)).toBe('$0.0015');
  expect(formatSpendDollars(50n)).toBe('$0.0001');
  expect(formatSpendDollars(49n)).toBe('<$0.0001');
  expect(formatSpendDollars(999_960n)).toBe('$1.00');
  expect(formatSpendDollars(1_010_000n)).toBe('$1.01');
});
