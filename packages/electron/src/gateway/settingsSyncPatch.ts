import type { BackendSettings } from "../../../backend/src/types";

export type SyncSettingsPatch = {
  layout: NonNullable<BackendSettings["layout"]>;
};

const ALLOWED_SYNC_SETTINGS_KEYS = new Set(["layout"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const normalizeSyncSettingsPatch = (
  settings: unknown,
): SyncSettingsPatch => {
  if (!isRecord(settings)) {
    throw new Error("settings.setSync only accepts a layout settings object.");
  }

  const unsupportedKeys = Object.keys(settings).filter(
    (key) => !ALLOWED_SYNC_SETTINGS_KEYS.has(key),
  );
  if (unsupportedKeys.length > 0) {
    throw new Error(
      `settings.setSync only accepts layout settings. Unsupported keys: ${unsupportedKeys.join(
        ", ",
      )}.`,
    );
  }

  if (!Object.prototype.hasOwnProperty.call(settings, "layout")) {
    throw new Error("settings.setSync requires a layout payload.");
  }

  const layout = settings.layout;
  if (!isRecord(layout)) {
    throw new Error("settings.setSync requires a layout object.");
  }

  return {
    layout: layout as SyncSettingsPatch["layout"],
  };
};
