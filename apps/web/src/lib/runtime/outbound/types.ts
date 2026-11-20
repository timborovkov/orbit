/** Shared outbound dispatch types used by email.send and later write adapters. */

export const EMAIL_SEND_ACTION = 'email.send';
export const EMAIL_SEND_JOB = 'email.send';

export type OutboundActionStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'blocked';

/** Action types with a real external write adapter. Expand as channels land. */
const WRITE_ADAPTERS = new Set<string>([EMAIL_SEND_ACTION]);

export function hasWriteAdapter(actionType: string): boolean {
  return WRITE_ADAPTERS.has(actionType);
}

/** Product rule: outbound email replies always require an administrator decision. */
export function alwaysRequiresApproval(actionType: string): boolean {
  return actionType === EMAIL_SEND_ACTION;
}
