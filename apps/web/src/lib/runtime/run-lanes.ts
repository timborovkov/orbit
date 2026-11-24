/**
 * Interactive (Playground) and background (discovery/email/channel) runs share
 * an agent, but interactive work must not be starved by background occupancy.
 */

export type RunLane = 'interactive' | 'background';

export type ActiveRunSnapshot = {
  id: string;
  origin: string;
  status: string;
  createdAt?: Date | string | null;
};

export function laneForOrigin(origin: string): RunLane {
  return origin === 'playground' ? 'interactive' : 'background';
}

/**
 * Count active runs that block admitting work on `lane`.
 * Interactive admissions ignore background runs; background admissions count every active run.
 */
export function countRunsBlockingLane(active: readonly ActiveRunSnapshot[], lane: RunLane): number {
  if (lane === 'interactive') {
    return active.filter((run) => laneForOrigin(run.origin) === 'interactive').length;
  }
  return active.length;
}

export function laneHasCapacity(
  active: readonly ActiveRunSnapshot[],
  lane: RunLane,
  maxConcurrentRuns: number,
): boolean {
  return countRunsBlockingLane(active, lane) < maxConcurrentRuns;
}

const originLabels: Record<string, string> = {
  playground: 'Playground test',
  discovery: 'X discovery',
  email: 'Email',
  channel: 'Channel work',
  replay: 'Replay',
};

export function originBusyLabel(origin: string): string {
  return originLabels[origin] ?? 'Background work';
}

function statusBusyLabel(status: string): string {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'awaiting_approval':
      return 'waiting for approval';
    default:
      return status;
  }
}

/** Plain-language concurrency block for operators (Playground and deferred work). */
export function concurrencyBusyMessage(
  busy: ActiveRunSnapshot | undefined,
  options?: { retryHint?: string },
): string {
  const retry =
    options?.retryHint ?? 'Try again in a minute, or open History to watch the active run.';
  if (!busy) {
    return `This agent is already busy with another run. ${retry}`;
  }
  const what = originBusyLabel(busy.origin);
  const how = statusBusyLabel(busy.status);
  return `${what} is ${how}, so this test could not start. ${retry}`;
}
