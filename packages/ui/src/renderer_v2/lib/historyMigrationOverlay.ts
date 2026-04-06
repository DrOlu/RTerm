interface HistoryMigrationOverlayState {
  status: string;
  ready: boolean;
  detectedLegacy: boolean;
}

/**
 * Only show the startup overlay for real legacy-history migration runs.
 * Normal startup finalization should stay silent once migration has already
 * been completed in a previous launch.
 */
export const shouldShowHistoryMigrationOverlay = (
  state: HistoryMigrationOverlayState | null | undefined,
): boolean => {
  if (!state) {
    return false;
  }

  if (state.status === "error") {
    return true;
  }

  return state.detectedLegacy && !state.ready;
};
