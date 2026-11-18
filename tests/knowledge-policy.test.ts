import { expect, test } from 'bun:test';

import { budgetDefaults } from '@/lib/budgets';
import { KNOWLEDGE_SEARCH_TOOL } from '@/lib/knowledge/types';
import { evaluateActionForTest } from '@/lib/policy/gateway';

const base = {
  lifecycle: 'shadow' as const,
  enabledTools: [] as string[],
  budgets: budgetDefaults,
  globalPaused: false,
};

test('knowledge.search is allowed as a read-only tool', () => {
  const result = evaluateActionForTest(base, {
    type: KNOWLEDGE_SEARCH_TOOL,
    idempotencyKey: 'knowledge-1',
    readOnly: true,
  });
  expect(result.decision).toBe('allow');
  expect(result.reasons.join(' ')).toContain('Read-only');
});

test('knowledge.search is denied when explicitly not enabled', () => {
  const result = evaluateActionForTest(
    { ...base, enabledTools: ['reply'] },
    {
      type: KNOWLEDGE_SEARCH_TOOL,
      idempotencyKey: 'knowledge-2',
      readOnly: true,
    },
  );
  expect(result.decision).toBe('deny');
  expect(result.reasons.join(' ')).toContain('not enabled');
});

test('paused agents cannot run knowledge.search', () => {
  const result = evaluateActionForTest(
    { ...base, lifecycle: 'paused' },
    {
      type: KNOWLEDGE_SEARCH_TOOL,
      idempotencyKey: 'knowledge-3',
      readOnly: true,
    },
  );
  expect(result.decision).toBe('deny');
});
