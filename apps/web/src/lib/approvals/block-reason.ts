import { INTRODUCTION_REVIEW } from '@/lib/runtime/introductions/types';
import { EMAIL_INTRODUCTION_ACTION } from '@/lib/runtime/outbound/types';

/** Human-readable reason approve is blocked before the request is sent. */
export function approvalBlockReason(input: {
  lifecycle: string;
  globalPaused: boolean;
  /** Introduction reviews skip the outbound gateway; do not block on pause. */
  actionType?: string;
}): string | null {
  // INTRODUCTION_REVIEW only records disclosure/consent — no outbound send.
  if (input.actionType === INTRODUCTION_REVIEW) return null;
  if (input.lifecycle === 'paused') {
    return 'Agent is paused. Resume it before approving outbound actions.';
  }
  if (input.lifecycle === 'stopped') {
    return 'Agent is stopped. External writes are blocked until it is resumed.';
  }
  if (input.lifecycle === 'shadow' && input.actionType === EMAIL_INTRODUCTION_ACTION) {
    return 'Switch the agent to Live before approving this introduction.';
  }
  if (input.globalPaused) {
    return 'Global outbound pause is enabled. Release it before approving.';
  }
  return null;
}

/** Clarify gateway deny strings shown after a failed approve. */
export function clarifyApprovalError(message: string): string {
  if (message.startsWith('Agent is paused')) {
    return 'Agent is paused. Resume it before approving outbound actions.';
  }
  if (message.startsWith('Global outbound pause is enabled')) {
    return 'Global outbound pause is enabled. Release it before approving.';
  }
  if (message.startsWith('Agent is stopped')) {
    return 'Agent is stopped. External writes are blocked until it is resumed.';
  }
  return message;
}
