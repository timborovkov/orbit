/** How a run authorises external side effects. */
export type ExecutionContext = 'standard' | 'replay';

/** Replay (and any future fixture modes) never leave the mock boundary. */
export function isReplayExecution(context: ExecutionContext): boolean {
  return context === 'replay';
}

/** Map a persisted run origin onto the policy execution context. */
export function executionContextForOrigin(origin: string | null | undefined): ExecutionContext {
  return origin === 'replay' ? 'replay' : 'standard';
}
