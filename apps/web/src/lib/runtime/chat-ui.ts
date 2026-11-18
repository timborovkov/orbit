import type { SimulationResult } from '@/lib/runtime/simulation';

/** Chunks the UI message stream protocol can emit for a playground reply. */
export type PlaygroundStreamChunk =
  | { type: 'start'; messageId?: string }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'reasoning-end'; id: string }
  | {
      type: 'tool-input-available';
      toolCallId: string;
      toolName: string;
      input: unknown;
      title?: string;
    }
  | { type: 'tool-output-available'; toolCallId: string; output: unknown }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'error'; errorText: string }
  | { type: 'finish'; finishReason?: 'stop' | 'error' | 'other' };

export interface PlaygroundStreamProgress {
  emittedStages: Set<'evaluator' | 'main'>;
  emittedActions: Set<string>;
  textStarted: boolean;
  textFinished: boolean;
}

export function createPlaygroundStreamProgress(): PlaygroundStreamProgress {
  return {
    emittedStages: new Set(),
    emittedActions: new Set(),
    textStarted: false,
    textFinished: false,
  };
}

function stageReasoning(
  stage: 'evaluator' | 'main',
  reason: string,
  relevant: boolean,
  priority: number,
) {
  const label = stage === 'evaluator' ? 'Evaluation' : 'Response planning';
  const relevance = relevant ? 'Relevant' : 'Not relevant';
  return `${label}: ${relevance} · ${Math.round(priority * 100)}% priority\n\n${reason}`;
}

function summarizeActions(actions: SimulationResult['actions']): string {
  if (!actions.length) {
    return 'No actions proposed. Simulation only — nothing was posted or sent.';
  }
  const lines = actions.map((action) => {
    const draft = action.draft ? `\n\nDraft:\n${action.draft}` : '';
    return `### ${action.type} (${action.policy})\n${action.reason}${draft}\n\n_${action.effect}_`;
  });
  return `Proposed actions (${actions.length}) — simulation only:\n\n${lines.join('\n\n')}`;
}

/**
 * Diff a simulation result against already-emitted progress and return new UI chunks.
 * Pure helper so route tests can cover streaming without a live worker.
 */
export function playgroundChunksFromResult(
  result: SimulationResult,
  progress: PlaygroundStreamProgress,
  options: { status: string; runId?: string } = { status: 'running' },
): PlaygroundStreamChunk[] {
  const chunks: PlaygroundStreamChunk[] = [];

  for (const step of result.steps) {
    if (progress.emittedStages.has(step.stage)) continue;
    progress.emittedStages.add(step.stage);
    const id = `reasoning-${step.stage}`;
    const text = stageReasoning(
      step.stage,
      step.decision.reason,
      step.decision.relevant,
      step.decision.priority,
    );
    chunks.push({ type: 'reasoning-start', id });
    chunks.push({ type: 'reasoning-delta', id, delta: text });
    chunks.push({ type: 'reasoning-end', id });
  }

  // Only emit action tool cards from the finalized result so evaluator candidates
  // that the main stage later drops or rewrites do not stick around as completed tools.
  const terminal = ['completed', 'failed', 'interrupted'].includes(options.status);
  if (terminal) {
    for (const action of result.actions) {
      const key = `${action.type}:${action.intentId ?? action.policy}:${action.draft ?? ''}`;
      if (progress.emittedActions.has(key)) continue;
      progress.emittedActions.add(key);
      const toolCallId = `action-${action.type}-${progress.emittedActions.size}`;
      chunks.push({
        type: 'tool-input-available',
        toolCallId,
        toolName: action.type,
        title: action.type,
        input: {
          reason: action.reason,
          draft: action.draft,
          recipients: undefined,
        },
      });
      chunks.push({
        type: 'tool-output-available',
        toolCallId,
        output: {
          policy: action.policy,
          effect: action.effect,
          intentId: action.intentId ?? null,
        },
      });
    }
  }

  if (terminal && !progress.textFinished) {
    if (!progress.textStarted) {
      chunks.push({ type: 'text-start', id: 'reply' });
      progress.textStarted = true;
    }
    if (result.error) {
      chunks.push({ type: 'text-delta', id: 'reply', delta: result.error });
    } else {
      chunks.push({ type: 'text-delta', id: 'reply', delta: summarizeActions(result.actions) });
    }
    if (options.runId) {
      chunks.push({
        type: 'text-delta',
        id: 'reply',
        delta: `\n\n_Run ${options.runId} · ${options.status}_`,
      });
    }
    chunks.push({ type: 'text-end', id: 'reply' });
    progress.textFinished = true;
    chunks.push({
      type: 'finish',
      finishReason: result.error || options.status !== 'completed' ? 'error' : 'stop',
    });
  }

  return chunks;
}

export function lastUserText(
  messages: { role: string; parts?: { type: string; text?: string }[]; content?: string }[],
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string' && message.content.trim())
      return message.content.trim();
    const text = (message.parts ?? [])
      .flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}
