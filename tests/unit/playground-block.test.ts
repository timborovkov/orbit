import { expect, test } from 'bun:test';

import {
  isPlaygroundAdmissionBlock,
  playgroundBlockRetryLabel,
} from '@/lib/runtime/playground-block';

test('detects concurrency and quota admission blocks', () => {
  expect(
    isPlaygroundAdmissionBlock(
      'X discovery is running, so this test could not start. Keep your message and retry.',
    ),
  ).toBe(true);
  expect(isPlaygroundAdmissionBlock('Agent concurrency limit reached. Work was deferred.')).toBe(
    true,
  );
  expect(isPlaygroundAdmissionBlock('Daily request quota reached. Work was deferred.')).toBe(true);
  expect(isPlaygroundAdmissionBlock('Simulation completed successfully.')).toBe(false);
});

test('retry label prefers free-slot wording for busy blocks', () => {
  expect(playgroundBlockRetryLabel('X discovery is running, so this test could not start.')).toBe(
    'Retry when free',
  );
  expect(playgroundBlockRetryLabel('Daily request quota reached.')).toBe('Retry');
});
