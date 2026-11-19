import { expect, test } from 'bun:test';

import { KNOWLEDGE_SEARCH_TOOL } from '@/lib/knowledge/types';
import {
  consumeKnowledgeToolStep,
  recordKnowledgeToolCall,
} from '@/lib/runtime/knowledge/tool-step';
import type { ToolCallRecord } from '@/lib/runtime/skills';
import { createToolStepGate } from '@/lib/runtime/tool-steps';

test('knowledge retrieval consumes a shared tool-step slot and records denials', () => {
  const gate = createToolStepGate(1);
  const toolCalls: ToolCallRecord[] = [];
  const args = { query: 'reset password', limit: 4 };

  expect(consumeKnowledgeToolStep(gate, toolCalls, args)).toEqual({ ok: true });
  expect(gate.used).toBe(1);
  expect(toolCalls).toHaveLength(0);

  recordKnowledgeToolCall(toolCalls, args, {
    policy: 'allow',
    result: { hitCount: 1 },
  });
  expect(toolCalls).toEqual([
    {
      tool: KNOWLEDGE_SEARCH_TOOL,
      args,
      policy: 'allow',
      result: { hitCount: 1 },
    },
  ]);

  const blocked = consumeKnowledgeToolStep(gate, toolCalls, args);
  expect(blocked).toEqual({
    ok: false,
    reason: 'Maximum tool steps for this run reached.',
  });
  expect(toolCalls).toHaveLength(2);
  expect(toolCalls[1]).toMatchObject({
    tool: KNOWLEDGE_SEARCH_TOOL,
    policy: 'deny',
    error: 'Maximum tool steps for this run reached.',
  });
});

test('exhausted gate still leaves room for skill/MCP accounting via shared used count', () => {
  const gate = createToolStepGate(2);
  const toolCalls: ToolCallRecord[] = [];
  expect(consumeKnowledgeToolStep(gate, toolCalls, { query: 'a' }).ok).toBe(true);
  expect(gate.tryConsume()).toBe(true);
  expect(gate.tryConsume()).toBe(false);
  expect(gate.used).toBe(2);
});
