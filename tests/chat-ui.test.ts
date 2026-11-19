import { describe, expect, test } from 'bun:test';

import {
  createPlaygroundStreamProgress,
  playgroundChunksFromResult,
} from '../apps/web/src/lib/runtime/chat-ui';
import type { SimulationResult } from '../apps/web/src/lib/runtime/simulation';

const baseResult = (): SimulationResult => ({
  steps: [],
  actions: [],
  error: null,
});

describe('playground chat UI helpers', () => {
  test('streams reasoning, tools and summary when a run completes', () => {
    const progress = createPlaygroundStreamProgress();
    const result: SimulationResult = {
      ...baseResult(),
      steps: [
        {
          stage: 'evaluator',
          model: 'test/model',
          inputTokens: 10,
          outputTokens: 5,
          decision: {
            relevant: true,
            priority: 0.8,
            reason: 'Looks like a support question.',
            actions: [{ type: 'reply', reason: 'Answer the question', draft: null }],
          },
        },
        {
          stage: 'main',
          model: 'test/model',
          inputTokens: 20,
          outputTokens: 12,
          decision: {
            relevant: true,
            priority: 0.9,
            reason: 'Reply with a short draft.',
            actions: [{ type: 'reply', reason: 'Answer the question', draft: 'Happy to help.' }],
          },
        },
      ],
      actions: [
        {
          type: 'reply',
          reason: 'Answer the question',
          draft: 'Happy to help.',
          policy: 'suppressed',
          effect: 'Simulation only. No external action performed.',
        },
      ],
    };

    const mid = playgroundChunksFromResult(result, progress, { status: 'running' });
    expect(mid.some((chunk) => chunk.type === 'reasoning-delta')).toBe(true);
    expect(mid.some((chunk) => chunk.type === 'tool-input-available')).toBe(false);
    expect(mid.some((chunk) => chunk.type === 'finish')).toBe(false);

    const done = playgroundChunksFromResult(result, progress, {
      status: 'completed',
      runId: 'run-1',
    });
    expect(done.some((chunk) => chunk.type === 'tool-input-available')).toBe(true);
    expect(done.some((chunk) => chunk.type === 'text-delta')).toBe(true);
    expect(done.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' });

    const again = playgroundChunksFromResult(result, progress, {
      status: 'completed',
      runId: 'run-1',
    });
    expect(again).toEqual([]);
  });

  test('emits an error finish when the run fails', () => {
    const progress = createPlaygroundStreamProgress();
    const result: SimulationResult = {
      ...baseResult(),
      error: 'No OpenRouter credential available.',
    };
    const chunks = playgroundChunksFromResult(result, progress, {
      status: 'failed',
      runId: 'run-2',
    });
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(true);
    expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'error' });
  });

  test('reports the reason for an interrupted run', () => {
    const chunks = playgroundChunksFromResult(baseResult(), createPlaygroundStreamProgress(), {
      status: 'interrupted',
      runId: 'run-4',
      deferReason: 'Agent paused. The queued job was cancelled.',
    });
    expect(chunks).toContainEqual({
      type: 'text-delta',
      id: 'reply',
      delta: 'The simulation was interrupted. Agent paused. The queued job was cancelled.',
    });
    expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'error' });
  });

  test('does not keep evaluator candidates that the main stage drops', () => {
    const progress = createPlaygroundStreamProgress();
    const evaluatorOnly: SimulationResult = {
      ...baseResult(),
      steps: [
        {
          stage: 'evaluator',
          model: 'test/model',
          inputTokens: 10,
          outputTokens: 5,
          decision: {
            relevant: true,
            priority: 0.7,
            reason: 'Candidate reply and escalate.',
            actions: [
              { type: 'reply', reason: 'Answer', draft: null },
              { type: 'escalate', reason: 'Needs human', draft: null },
            ],
          },
        },
      ],
      actions: [
        {
          type: 'reply',
          reason: 'Answer',
          draft: null,
          policy: 'suppressed',
          effect: 'Simulation only. No external action performed.',
        },
        {
          type: 'escalate',
          reason: 'Needs human',
          draft: null,
          policy: 'suppressed',
          effect: 'Simulation only. No external action performed.',
        },
      ],
    };

    const mid = playgroundChunksFromResult(evaluatorOnly, progress, { status: 'running' });
    expect(mid.filter((chunk) => chunk.type === 'tool-input-available')).toHaveLength(0);

    const finalized: SimulationResult = {
      ...evaluatorOnly,
      steps: [
        ...evaluatorOnly.steps,
        {
          stage: 'main',
          model: 'test/model',
          inputTokens: 20,
          outputTokens: 8,
          decision: {
            relevant: true,
            priority: 0.9,
            reason: 'Reply only; drop escalate.',
            actions: [{ type: 'reply', reason: 'Answer', draft: 'Here you go.' }],
          },
        },
      ],
      actions: [
        {
          type: 'reply',
          reason: 'Answer',
          draft: 'Here you go.',
          policy: 'suppressed',
          effect: 'Simulation only. No external action performed.',
        },
      ],
    };

    const done = playgroundChunksFromResult(finalized, progress, {
      status: 'completed',
      runId: 'run-3',
    });
    const tools = done.filter((chunk) => chunk.type === 'tool-input-available');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ toolName: 'reply' });
    expect(
      done.some((chunk) => chunk.type === 'tool-input-available' && chunk.toolName === 'escalate'),
    ).toBe(false);
  });
});
