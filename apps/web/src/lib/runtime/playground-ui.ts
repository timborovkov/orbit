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

/** Inactive Access panels stay mounted (`hidden`) so draft form state survives section switches. */
export function accessSectionPanelHidden(activeId: string, sectionId: string) {
  return activeId !== sectionId;
}

/** Same mount/hide contract for Knowledge Documents / Inspector / Playground sections. */
export function knowledgeSectionPanelHidden(activeId: string, sectionId: string) {
  return activeId !== sectionId;
}

export interface PlaygroundVersionSelection {
  /** `currentConfigurationId` when the user last picked an override. */
  baseId: string;
  overrideId: string | null;
}

/**
 * Effective Playground configuration id. When the workspace current id moves
 * (for example after a save), any prior historical override is ignored.
 */
export function playgroundEffectiveConfigurationId(
  selection: PlaygroundVersionSelection,
  currentConfigurationId: string,
) {
  if (selection.baseId !== currentConfigurationId) return currentConfigurationId;
  return selection.overrideId ?? currentConfigurationId;
}
