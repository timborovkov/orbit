/** Pure polling helpers for playground simulation runs (no DB or auth). */

const terminalStatuses = new Set(['completed', 'failed', 'interrupted']);

/** True when a simulation run will not change again. */
export function isTerminalSimulationStatus(status: string) {
  return terminalStatuses.has(status);
}

export function isExpiredSimulationRun(run: { status: string; expiresAt: Date }) {
  return (
    (run.status === 'running' || run.status === 'queued') && run.expiresAt.getTime() < Date.now()
  );
}

interface WatchOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll through an injected lookup until terminal, missing, aborted, or deadline.
 * Route adapters use the authorized wrapper in `lib/server/playground-queries`.
 */
export async function* watchSimulationRunWithLookup<T extends { status: string }>(
  lookup: (runId: string) => Promise<T | null>,
  runId: string,
  options: WatchOptions = {},
): AsyncGenerator<T | null> {
  const deadlineMs = options.deadlineMs ?? 150_000;
  const intervalMs = options.intervalMs ?? 750;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = Date.now();

  while (Date.now() - started < deadlineMs) {
    if (options.signal?.aborted) return;

    const run = await lookup(runId);
    yield run;
    if (!run || isTerminalSimulationStatus(run.status)) return;

    await sleep(intervalMs);
  }
}
