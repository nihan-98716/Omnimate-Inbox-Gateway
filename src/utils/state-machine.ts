export enum AssetState {
  PROCESS_NOW = 'PROCESS_NOW',
  SAVE_FOR_LATER = 'SAVE_FOR_LATER',
  ARCHIVE = 'ARCHIVE',
  DELETED = 'DELETED'
}

export const VALID_TRANSITIONS: Record<AssetState, AssetState[]> = {
  [AssetState.PROCESS_NOW]: [AssetState.SAVE_FOR_LATER, AssetState.ARCHIVE, AssetState.DELETED],
  [AssetState.SAVE_FOR_LATER]: [AssetState.PROCESS_NOW, AssetState.ARCHIVE, AssetState.DELETED],
  [AssetState.ARCHIVE]: [AssetState.PROCESS_NOW, AssetState.DELETED],
  [AssetState.DELETED]: [AssetState.PROCESS_NOW] // Restore is the only allowed move
};

/**
 * Validates whether transitioning from state 'from' to state 'to' is allowed.
 */
export function isValidTransition(from: AssetState, to: AssetState): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Generates hook updates based on state changes (such as timestamp logging)
 */
export function getStateHookUpdate(to: AssetState): { deletedAt: Date | null } {
  if (to === AssetState.DELETED) {
    return { deletedAt: new Date() };
  }
  return { deletedAt: null };
}
