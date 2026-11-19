import { KNOWLEDGE_SEARCH_TOOL } from '@/lib/knowledge/types';
import type { ToolCallRecord } from '@/lib/runtime/skills';
import type { ToolStepGate } from '@/lib/runtime/tool-steps';

const TOOL_STEP_EXHAUSTED = 'Maximum tool steps for this run reached.';

/** Reserve one shared maxToolStepsPerRun slot before knowledge retrieval. */
export function consumeKnowledgeToolStep(
  toolSteps: ToolStepGate,
  toolCalls: ToolCallRecord[],
  args: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  if (!toolSteps.tryConsume()) {
    toolCalls.push({
      tool: KNOWLEDGE_SEARCH_TOOL,
      args,
      policy: 'deny',
      result: null,
      error: TOOL_STEP_EXHAUSTED,
    });
    return { ok: false, reason: TOOL_STEP_EXHAUSTED };
  }
  return { ok: true };
}

export function recordKnowledgeToolCall(
  toolCalls: ToolCallRecord[],
  args: Record<string, unknown>,
  entry: Omit<ToolCallRecord, 'tool' | 'args'>,
) {
  toolCalls.push({ tool: KNOWLEDGE_SEARCH_TOOL, args, ...entry });
}
