import { z } from 'zod';

export const lifecycleStates = ['shadow', 'paused', 'live', 'stopped'] as const;
export type LifecycleState = (typeof lifecycleStates)[number];

export const lifecycleSchema = z.enum(lifecycleStates);

export const lifecycleLabels: Record<LifecycleState, string> = {
  shadow: 'Shadow',
  paused: 'Paused',
  live: 'Live',
  stopped: 'Stopped',
};

export const lifecycleDescriptions: Record<LifecycleState, string> = {
  shadow: 'Agent may process work. External writes are suppressed and logged. This is the default.',
  paused: 'Agent does not accept new worker jobs. Existing runs finish or expire.',
  live: 'Live activation permits policy-approved external writes for registered adapters (currently administrator-approved email replies). Other proposals stay suppressed.',
  stopped:
    'Pending jobs are cancelled where feasible. External writes are blocked until an administrator changes state.',
};

/** Simulations and worker jobs are refused while paused or stopped. */
export function canEnqueueSimulation(lifecycle: LifecycleState): boolean {
  return lifecycle !== 'stopped' && lifecycle !== 'paused';
}

/** Background/event jobs require an active lifecycle that is not paused or stopped. */
export function canAcceptBackgroundWork(lifecycle: LifecycleState): boolean {
  return lifecycle === 'shadow' || lifecycle === 'live';
}

/** External write dispatch requires Live; adapters and approvals still gate at the policy layer. */
export function externalWritesPermitted(lifecycle: LifecycleState): boolean {
  return lifecycle === 'live';
}

export function shouldCancelPendingJobs(lifecycle: LifecycleState): boolean {
  return lifecycle === 'stopped' || lifecycle === 'paused';
}
