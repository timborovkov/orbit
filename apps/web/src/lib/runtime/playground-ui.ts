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

/** True when streamed assistant text acknowledges that the durable job is queued. */
export function playgroundMessagesAcknowledgeQueue(
  messages: { parts?: { type: string; text?: string }[] }[],
): boolean {
  return messages.some((message) =>
    (message.parts ?? []).some(
      (part) =>
        part.type === 'text' &&
        typeof part.text === 'string' &&
        part.text.startsWith('Simulation queued'),
    ),
  );
}

/**
 * Whether the workspace should soft-refresh for a newly queued run.
 * Refreshes once per busy cycle when the queue acknowledgement arrives.
 */
export function shouldRefreshWorkspaceForQueuedRun(options: {
  busy: boolean;
  alreadyRefreshed: boolean;
  messages: { parts?: { type: string; text?: string }[] }[];
}): boolean {
  if (!options.busy || options.alreadyRefreshed) return false;
  return playgroundMessagesAcknowledgeQueue(options.messages);
}

/** Inactive Access panels stay mounted (`hidden`) so draft form state survives section switches. */
export function accessSectionPanelHidden(activeId: string, sectionId: string) {
  return activeId !== sectionId;
}
