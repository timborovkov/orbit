/** Shared pure helpers for Playground client behaviour (unit-tested). */

export const PLAYGROUND_ATTACHMENTS_UNSUPPORTED =
  'Attachments are not supported yet. Paste a post or question as text only.';

/** Reject any attached files until the simulation runtime can consume them. */
export function playgroundAttachmentRejection(
  files: { filename?: string | null }[] | null | undefined,
): string | null {
  if (!files?.length) return null;
  return PLAYGROUND_ATTACHMENTS_UNSUPPORTED;
}

function messageHasQueueAck(message: { parts?: { type: string; text?: string }[] }): boolean {
  return (message.parts ?? []).some(
    (part) =>
      part.type === 'text' &&
      typeof part.text === 'string' &&
      part.text.startsWith('Simulation queued'),
  );
}

/**
 * True when the *current* submission's assistant reply acknowledges the queue.
 * Only inspects messages after the latest user turn so a prior run's ack cannot
 * fire a refresh for a new submission.
 */
export function playgroundMessagesAcknowledgeQueue(
  messages: { role?: string; parts?: { type: string; text?: string }[] }[],
): boolean {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) return false;

  return messages.slice(lastUserIndex + 1).some((message) => {
    if (message.role && message.role !== 'assistant') return false;
    return messageHasQueueAck(message);
  });
}

/**
 * Whether the workspace should soft-refresh for a newly queued run.
 * Refreshes once per busy cycle when the current submission's queue ack arrives.
 */
export function shouldRefreshWorkspaceForQueuedRun(options: {
  busy: boolean;
  alreadyRefreshed: boolean;
  messages: { role?: string; parts?: { type: string; text?: string }[] }[];
}): boolean {
  if (!options.busy || options.alreadyRefreshed) return false;
  return playgroundMessagesAcknowledgeQueue(options.messages);
}

/** Inactive Access panels stay mounted (`hidden`) so draft form state survives section switches. */
export function accessSectionPanelHidden(activeId: string, sectionId: string) {
  return activeId !== sectionId;
}
