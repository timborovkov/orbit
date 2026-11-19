import { describe, expect, test } from 'bun:test';

import {
  accessSectionPanelHidden,
  knowledgeSectionPanelHidden,
  PLAYGROUND_ATTACHMENTS_UNSUPPORTED,
  playgroundAttachmentRejection,
  playgroundEffectiveConfigurationId,
} from '../apps/web/src/lib/runtime/playground-ui';
import {
  isExpiredSimulationRun,
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

describe('access section panel visibility', () => {
  test('keeps inactive panels mounted via hidden rather than unmounting', () => {
    expect(accessSectionPanelHidden('budgets', 'budgets')).toBe(false);
    expect(accessSectionPanelHidden('budgets', 'consent')).toBe(true);
    expect(knowledgeSectionPanelHidden('documents', 'documents')).toBe(false);
    expect(knowledgeSectionPanelHidden('documents', 'inspector')).toBe(true);
  });
});

describe('playground configuration selection', () => {
  test('uses an explicit override until the current configuration changes', () => {
    expect(
      playgroundEffectiveConfigurationId(
        { baseId: 'current-v1', overrideId: 'old-version' },
        'current-v1',
      ),
    ).toBe('old-version');
    expect(
      playgroundEffectiveConfigurationId(
        { baseId: 'current-v1', overrideId: 'old-version' },
        'current-v2',
      ),
    ).toBe('current-v2');
    expect(
      playgroundEffectiveConfigurationId({ baseId: 'current-v2', overrideId: null }, 'current-v2'),
    ).toBe('current-v2');
  });
});

describe('simulation run watch service', () => {
  test('classifies terminal run statuses', () => {
    expect(isTerminalSimulationStatus('completed')).toBe(true);
    expect(isTerminalSimulationStatus('failed')).toBe(true);
    expect(isTerminalSimulationStatus('interrupted')).toBe(true);
    expect(isTerminalSimulationStatus('running')).toBe(false);
    expect(isTerminalSimulationStatus('queued')).toBe(false);
    expect(isTerminalSimulationStatus('awaiting_approval')).toBe(false);
  });

  test('treats only running or queued past-deadline runs as expired', () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    expect(isExpiredSimulationRun({ status: 'running', expiresAt: past })).toBe(true);
    expect(isExpiredSimulationRun({ status: 'queued', expiresAt: past })).toBe(true);
    expect(isExpiredSimulationRun({ status: 'awaiting_approval', expiresAt: past })).toBe(false);
    expect(isExpiredSimulationRun({ status: 'completed', expiresAt: past })).toBe(false);
    expect(isExpiredSimulationRun({ status: 'running', expiresAt: future })).toBe(false);
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
