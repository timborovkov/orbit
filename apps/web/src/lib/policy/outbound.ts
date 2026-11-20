import { externalWritesPermitted, type LifecycleState } from '@/lib/lifecycle';
import { type ExecutionContext, isReplayExecution } from '@/lib/policy/execution-context';

/**
 * Final structural gate for any external write adapter.
 * Future outbound dispatch (email replies, social posts, …) must call this
 * before contacting a provider. Replay always refuses, regardless of lifecycle
 * or whether an adapter is registered.
 */
export function authorizeOutboundDispatch(input: {
  executionContext: ExecutionContext;
  lifecycle: LifecycleState;
  /** True when a concrete adapter exists for this action type. */
  adapterAvailable: boolean;
}): { allowed: true } | { allowed: false; reason: string } {
  if (isReplayExecution(input.executionContext)) {
    return {
      allowed: false,
      reason: 'Replay execution context blocks all external writes.',
    };
  }
  if (!externalWritesPermitted(input.lifecycle)) {
    return {
      allowed: false,
      reason: 'Agent lifecycle does not permit external writes.',
    };
  }
  if (!input.adapterAvailable) {
    return {
      allowed: false,
      reason: 'No external action adapter is available for this write.',
    };
  }
  return { allowed: true };
}
