/**
 * Reserved hook for future Telegram/Slack (and other) approval pings.
 * Production leaves the default no-op notifier; channels are not built yet.
 */

export interface ApprovalPendingEvent {
  intentId: string;
  agentId: string;
  runId: string | null;
  actionType: string;
  reason: string;
  createdAt: Date;
}

export type ApprovalNotifier = (event: ApprovalPendingEvent) => Promise<void> | void;

let notifier: ApprovalNotifier = () => undefined;

/** Replace the notifier (tests or a future channel adapter). */
export function setApprovalNotifier(next: ApprovalNotifier) {
  notifier = next;
}

export function resetApprovalNotifier() {
  notifier = () => undefined;
}

/** Fire-and-forget friendly: callers should not fail the approval path if this throws. */
export async function notifyApprovalPending(event: ApprovalPendingEvent) {
  try {
    await notifier(event);
  } catch {
    // Channel outages must not block suspension or intent persistence.
  }
}
