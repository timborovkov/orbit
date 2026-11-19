import { expect, test } from 'bun:test';

import { budgetDefaults } from '@/lib/budgets';
import { KNOWLEDGE_SEARCH_TOOL } from '@/lib/knowledge/types';
import { evaluateActionForTest } from '@/lib/policy/gateway';

const base = {
  lifecycle: 'shadow' as const,
  enabledTools: [KNOWLEDGE_SEARCH_TOOL],
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

test('knowledge.search requires explicit enablement even when the tool list is empty', () => {
  const result = evaluateActionForTest(
    { ...base, enabledTools: [] },
    {
      type: KNOWLEDGE_SEARCH_TOOL,
      idempotencyKey: 'knowledge-2',
      readOnly: true,
    },
  );
  expect(result.decision).toBe('deny');
  expect(result.reasons.join(' ')).toContain('not enabled');
});

test('enabling only knowledge.search preserves empty-list semantics for other native tools', () => {
  const withKnowledge = { ...base, enabledTools: [KNOWLEDGE_SEARCH_TOOL] };
  expect(
    evaluateActionForTest(withKnowledge, {
      type: 'reply',
      idempotencyKey: 'knowledge-other-1',
    }).decision,
  ).toBe('suppressed');
  expect(
    evaluateActionForTest(
      { ...base, enabledTools: [KNOWLEDGE_SEARCH_TOOL, 'like'] },
      { type: 'reply', idempotencyKey: 'knowledge-other-2' },
    ).decision,
  ).toBe('deny');
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
