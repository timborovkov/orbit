import { describe, expect, test } from 'bun:test';

import {
  accessSectionPanelHidden,
  PLAYGROUND_ATTACHMENTS_UNSUPPORTED,
  playgroundAttachmentRejection,
  playgroundMessagesAcknowledgeQueue,
  shouldRefreshWorkspaceForQueuedRun,
} from '../apps/web/src/lib/runtime/playground-ui';
import {
  isTerminalSimulationStatus,
  watchSimulationRunWithLookup,
} from '../apps/web/src/lib/runtime/simulation-watch';

describe('playground attachment gate', () => {
  test('allows text-only submissions', () => {
    expect(playgroundAttachmentRejection([])).toBeNull();
    expect(playgroundAttachmentRejection(undefined)).toBeNull();
  });

  test('rejects attached files instead of silently dropping them', () => {
    expect(playgroundAttachmentRejection([{ filename: 'brief.pdf' }])).toBe(
      PLAYGROUND_ATTACHMENTS_UNSUPPORTED,
    );
  });
});

describe('playground queue refresh', () => {
  test('detects the streamed queue acknowledgement for the current submission', () => {
    expect(
      playgroundMessagesAcknowledgeQueue([
        { role: 'user', parts: [{ type: 'text', text: 'Help me' }] },
        {
          role: 'assistant',
          parts: [{ type: 'text', text: 'Simulation queued. Waiting for the worker…' }],
        },
      ]),
    ).toBe(true);
    expect(
      playgroundMessagesAcknowledgeQueue([
        { role: 'user', parts: [{ type: 'text', text: 'Help me' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'Hello' }] },
      ]),
    ).toBe(false);
  });

  test('ignores a prior run ack when a new user message has no assistant reply yet', () => {
    expect(
      playgroundMessagesAcknowledgeQueue([
        { role: 'user', parts: [{ type: 'text', text: 'First' }] },
        {
          role: 'assistant',
          parts: [{ type: 'text', text: 'Simulation queued. Waiting for the worker…' }],
        },
        { role: 'user', parts: [{ type: 'text', text: 'Second' }] },
      ]),
    ).toBe(false);
  });

  test('refreshes once per busy cycle when the current queue ack arrives', () => {
    const messages = [
      { role: 'user', parts: [{ type: 'text', text: 'Help me' }] },
      {
        role: 'assistant',
        parts: [{ type: 'text', text: 'Simulation queued. Waiting for the worker…' }],
      },
    ];
    expect(
      shouldRefreshWorkspaceForQueuedRun({ busy: true, alreadyRefreshed: false, messages }),
    ).toBe(true);
    expect(
      shouldRefreshWorkspaceForQueuedRun({ busy: true, alreadyRefreshed: true, messages }),
    ).toBe(false);
    expect(
      shouldRefreshWorkspaceForQueuedRun({ busy: false, alreadyRefreshed: false, messages }),
    ).toBe(false);
  });
});

describe('access section panel visibility', () => {
  test('keeps inactive panels mounted via hidden rather than unmounting', () => {
    expect(accessSectionPanelHidden('budgets', 'budgets')).toBe(false);
    expect(accessSectionPanelHidden('budgets', 'consent')).toBe(true);
  });
});

describe('simulation run watch service', () => {
  test('classifies terminal run statuses', () => {
    expect(isTerminalSimulationStatus('completed')).toBe(true);
    expect(isTerminalSimulationStatus('failed')).toBe(true);
    expect(isTerminalSimulationStatus('interrupted')).toBe(true);
    expect(isTerminalSimulationStatus('running')).toBe(false);
    expect(isTerminalSimulationStatus('queued')).toBe(false);
  });

  test('polls through lookup until the run is terminal', async () => {
    const sleeps: number[] = [];
    const statuses = ['queued', 'running', 'completed'] as const;
    let index = 0;

    const observations: Array<{ status: string } | null> = [];
    for await (const run of watchSimulationRunWithLookup(
      async () => {
        const status = statuses[index] ?? 'completed';
        index += 1;
        return { id: 'run-1', status };
      },
      'run-1',
      {
        intervalMs: 10,
        deadlineMs: 1000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    )) {
      observations.push(run);
    }

    expect(observations.map((run) => run?.status)).toEqual(['queued', 'running', 'completed']);
    expect(sleeps).toEqual([10, 10]);
  });

  test('stops when the run disappears', async () => {
    const observations: Array<{ status: string } | null> = [];
    for await (const run of watchSimulationRunWithLookup(async () => null, 'missing', {
      deadlineMs: 1000,
      sleep: async () => undefined,
    })) {
      observations.push(run);
    }
    expect(observations).toEqual([null]);
  });

  test('stops when the abort signal fires before the next poll', async () => {
    const controller = new AbortController();
    let calls = 0;
    const observations: Array<{ status: string } | null> = [];
    for await (const run of watchSimulationRunWithLookup(
      async () => {
        calls += 1;
        return { id: 'run-2', status: 'running' };
      },
      'run-2',
      {
        signal: controller.signal,
        intervalMs: 5,
        deadlineMs: 1000,
        sleep: async () => {
          controller.abort();
        },
      },
    )) {
      observations.push(run);
    }
    expect(calls).toBe(1);
    expect(observations).toHaveLength(1);
  });
});
