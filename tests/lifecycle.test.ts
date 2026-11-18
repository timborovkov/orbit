import { expect, test } from 'bun:test';

import {
  canAcceptBackgroundWork,
  canEnqueueSimulation,
  externalWritesPermitted,
  lifecycleSchema,
  shouldCancelPendingJobs,
} from '@/lib/lifecycle';

test('lifecycle states and transitions', () => {
  expect(lifecycleSchema.parse('shadow')).toBe('shadow');
  expect(canEnqueueSimulation('shadow')).toBe(true);
  expect(canEnqueueSimulation('paused')).toBe(false);
  expect(canEnqueueSimulation('live')).toBe(true);
  expect(canEnqueueSimulation('stopped')).toBe(false);
  expect(canAcceptBackgroundWork('shadow')).toBe(true);
  expect(canAcceptBackgroundWork('live')).toBe(true);
  expect(canAcceptBackgroundWork('paused')).toBe(false);
  expect(canAcceptBackgroundWork('stopped')).toBe(false);
  expect(externalWritesPermitted('live')).toBe(true);
  expect(externalWritesPermitted('shadow')).toBe(false);
  expect(shouldCancelPendingJobs('stopped')).toBe(true);
  expect(shouldCancelPendingJobs('paused')).toBe(true);
  expect(shouldCancelPendingJobs('shadow')).toBe(false);
});
