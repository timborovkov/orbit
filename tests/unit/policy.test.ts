import { expect, test } from 'bun:test';

import { budgetDefaults } from '@/lib/budgets';
import { evaluateActionForTest } from '@/lib/policy/gateway';
import { authorizeOutboundDispatch } from '@/lib/policy/outbound';

const base = {
  lifecycle: 'shadow' as const,
  enabledTools: [] as string[],
  consentRequiredTools: [],
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

test('email.send always needs approval and allows after approval in Live', () => {
  const email = { ...base, runChannel: 'email' };
  expect(
    evaluateActionForTest(email, { type: 'email.send', idempotencyKey: 'email-shadow' }).decision,
  ).toBe('needs-approval');
  expect(
    evaluateActionForTest(
      { ...email, lifecycle: 'live' },
      { type: 'email.send', idempotencyKey: 'email-live' },
    ).decision,
  ).toBe('needs-approval');
  expect(
    evaluateActionForTest(
      email,
      { type: 'email.send', idempotencyKey: 'email-shadow-skip' },
      { skipApproval: true },
    ).decision,
  ).toBe('suppressed');
  expect(
    evaluateActionForTest(
      { ...email, lifecycle: 'live' },
      { type: 'email.send', idempotencyKey: 'email-live-skip' },
      { skipApproval: true },
    ).decision,
  ).toBe('allow');
});

test('read-only tools can allow when budgets permit', () => {
  const result = evaluateActionForTest(
    { ...base, enabledTools: ['knowledge.search'] },
    {
      type: 'knowledge.search',
      idempotencyKey: 'k8',
      readOnly: true,
    },
  );
  expect(result.decision).toBe('allow');
});

test('administrator review is opt-in for introductions and escalations', () => {
  for (const type of ['introduce', 'escalate']) {
    const action = { type, idempotencyKey: type };
    const configured = { ...base, approvalTools: [type] };
    expect(evaluateActionForTest(base, action).decision).toBe('suppressed');
    expect(evaluateActionForTest(configured, action).decision).toBe('needs-approval');
    expect(evaluateActionForTest(configured, { ...action, preliminary: true }).decision).toBe(
      'suppressed',
    );
  }
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

test('replay execution context suppresses writes before approval', () => {
  const result = evaluateActionForTest(
    {
      ...base,
      lifecycle: 'live',
      executionContext: 'replay',
      approvalTools: ['reply'],
    },
    { type: 'reply', idempotencyKey: 'replay-1' },
  );
  expect(result.decision).toBe('suppressed');
  expect(result.reasons.join(' ')).toContain('Replay execution suppresses');
});

test('outbound dispatch gate refuses replay even when an adapter is available', () => {
  const denied = authorizeOutboundDispatch({
    executionContext: 'replay',
    lifecycle: 'live',
    adapterAvailable: true,
  });
  expect(denied.allowed).toBe(false);
  if (!denied.allowed) expect(denied.reason).toContain('Replay');

  const withoutAdapter = authorizeOutboundDispatch({
    executionContext: 'standard',
    lifecycle: 'live',
    adapterAvailable: false,
  });
  expect(withoutAdapter.allowed).toBe(false);

  const allowed = authorizeOutboundDispatch({
    executionContext: 'standard',
    lifecycle: 'live',
    adapterAvailable: true,
  });
  expect(allowed.allowed).toBe(true);
});
