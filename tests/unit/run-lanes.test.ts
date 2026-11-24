import { expect, test } from 'bun:test';

import {
  concurrencyBusyMessage,
  countRunsBlockingLane,
  laneForOrigin,
  laneHasCapacity,
  originBusyLabel,
} from '@/lib/runtime/run-lanes';

test('playground is interactive; discovery and email are background', () => {
  expect(laneForOrigin('playground')).toBe('interactive');
  expect(laneForOrigin('discovery')).toBe('background');
  expect(laneForOrigin('email')).toBe('background');
  expect(laneForOrigin('channel')).toBe('background');
});

test('interactive admission ignores background occupancy', () => {
  const active = [
    { id: '1', origin: 'discovery' as const, status: 'running' },
    { id: '2', origin: 'email' as const, status: 'queued' },
  ];
  expect(countRunsBlockingLane(active, 'interactive')).toBe(0);
  expect(laneHasCapacity(active, 'interactive', 1)).toBe(true);
  expect(countRunsBlockingLane(active, 'background')).toBe(2);
  expect(laneHasCapacity(active, 'background', 1)).toBe(false);
});

test('interactive admission still respects other playground runs', () => {
  const active = [{ id: '1', origin: 'playground' as const, status: 'awaiting_approval' }];
  expect(laneHasCapacity(active, 'interactive', 1)).toBe(false);
  expect(concurrencyBusyMessage(active[0])).toContain('Playground test');
  expect(concurrencyBusyMessage(active[0])).toContain('waiting for approval');
});

test('busy labels describe discovery occupancy', () => {
  expect(originBusyLabel('discovery')).toBe('X discovery');
  expect(concurrencyBusyMessage({ id: '1', origin: 'discovery', status: 'running' })).toContain(
    'X discovery is running',
  );
});
