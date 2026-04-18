import type { HistoryMigrationState } from "../../../backend/src/services/history/HistoryStorageMigration";

const STARTUP_PREPARATION_TITLE = "Preparing application startup";
const DEFAULT_STARTUP_FAILURE_TITLE = "Application startup failed";
const DEFAULT_STARTUP_FAILURE_MESSAGE = "RTerm could not finish startup.";

const normalizeProgressBounds = (
  state: HistoryMigrationState,
): Pick<HistoryMigrationState, "completedUnits" | "totalUnits" | "percent"> => {
  const totalUnits = Math.max(
    1,
    Number.isFinite(state.totalUnits) ? state.totalUnits : 0,
    Number.isFinite(state.completedUnits) ? state.completedUnits : 0,
  );
  const completedUnits = Math.min(
    totalUnits,
    Math.max(
      0,
      Number.isFinite(state.completedUnits) ? state.completedUnits : 0,
    ),
  );
  const percent = Math.max(
    0,
    Math.min(
      100,
      Number.isFinite(state.percent)
        ? state.percent
        : Math.round((completedUnits / totalUnits) * 100),
    ),
  );
  return {
    completedUnits,
    totalUnits,
    percent,
  };
};

const buildFinalizingMessage = (detectedLegacy: boolean): string =>
  detectedLegacy
    ? "Conversation history migration finished. Finishing application startup."
    : "History storage is ready. Finishing application startup.";

export const INITIAL_HISTORY_STARTUP_STATE: HistoryMigrationState = {
  status: "idle",
  ready: false,
  active: false,
  blocking: true,
  detectedLegacy: false,
  phase: "idle",
  title: "Preparing history storage",
  message: "Checking stored conversations.",
  completedUnits: 0,
  totalUnits: 0,
  percent: 0,
};

export const normalizeHistoryMigrationStateForStartupBarrier = (
  state: HistoryMigrationState,
): HistoryMigrationState => {
  if (state.status === "error") {
    return {
      ...state,
      ready: false,
      active: false,
      blocking: true,
      phase: "error",
    };
  }

  if (state.status === "done") {
    return {
      ...state,
      ...normalizeProgressBounds({
        ...state,
        completedUnits: Math.max(state.completedUnits, state.totalUnits, 1),
        totalUnits: Math.max(state.totalUnits, state.completedUnits, 1),
        percent: 100,
      }),
      status: "running",
      ready: false,
      active: false,
      blocking: true,
      phase: "finalizing",
      title: STARTUP_PREPARATION_TITLE,
      message: buildFinalizingMessage(state.detectedLegacy),
      error: undefined,
    };
  }

  return {
    ...state,
    ready: false,
    blocking: true,
    error: undefined,
  };
};

export const buildReadyHistoryStartupState = (
  state: HistoryMigrationState,
): HistoryMigrationState => {
  const progress = normalizeProgressBounds({
    ...state,
    completedUnits: Math.max(state.completedUnits, state.totalUnits, 1),
    totalUnits: Math.max(state.totalUnits, state.completedUnits, 1),
    percent: 100,
  });
  return {
    ...state,
    ...progress,
    status: "done",
    ready: true,
    active: false,
    blocking: false,
    phase: "done",
    title: "History storage ready",
    message: state.detectedLegacy
      ? "Conversation history migration finished."
      : "History storage is ready.",
    error: undefined,
  };
};

export const buildHistoryStartupErrorState = (
  state: HistoryMigrationState,
  error: unknown,
  options?: {
    title?: string;
    message?: string;
  },
): HistoryMigrationState => ({
  ...state,
  status: "error",
  ready: false,
  active: false,
  blocking: true,
  phase: "error",
  title: options?.title || DEFAULT_STARTUP_FAILURE_TITLE,
  message: options?.message || DEFAULT_STARTUP_FAILURE_MESSAGE,
  error: error instanceof Error ? error.message : String(error),
});
