/** Shared pure helpers for Playground client behaviour (unit-tested). */

export const PLAYGROUND_ATTACHMENTS_UNSUPPORTED =
  'Attachments are not supported yet. Paste a post or question as text only.';

/** Inactive Access panels stay mounted (`hidden`) so draft form state survives section switches. */
export function accessSectionPanelHidden(activeId: string, sectionId: string) {
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
