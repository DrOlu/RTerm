import { normalizeSyncSettingsPatch } from "./settingsSyncPatch";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const assertThrows = (
  fn: () => unknown,
  pattern: RegExp,
  message: string,
): void => {
  try {
    fn();
  } catch (error) {
    const actualMessage = error instanceof Error ? error.message : String(error);
    if (!pattern.test(actualMessage)) {
      throw new Error(
        `${message}: unexpected error message "${actualMessage}"`,
      );
    }
    return;
  }
  throw new Error(`${message}: expected error`);
};

const runCase = (name: string, fn: () => void): void => {
  fn();
  console.log(`PASS ${name}`);
};

runCase("accepts layout-only sync settings patches", () => {
  const patch = normalizeSyncSettingsPatch({
    layout: {
      panelOrder: ["chat", "terminal"],
      panelSizes: [55, 45],
      v2: { root: { type: "panel" } },
    },
  });

  assertEqual(
    patch.layout.panelOrder?.[0],
    "chat",
    "layout panel order should be preserved",
  );
  assertEqual(
    patch.layout.panelSizes?.[1],
    45,
    "layout panel sizes should be preserved",
  );
});

runCase("rejects websocket gateway changes through sync settings patches", () => {
  assertThrows(
    () =>
      normalizeSyncSettingsPatch({
        gateway: {
          ws: {
            access: "internet",
            port: 17999,
            allowedCidrs: [],
          },
        },
      }),
    /Unsupported keys: gateway/,
    "sync settings patches must not accept gateway changes",
  );
});

runCase("rejects non-layout backend settings through sync settings patches", () => {
  assertThrows(
    () =>
      normalizeSyncSettingsPatch({
        recursionLimit: 500,
        layout: {
          panelOrder: ["chat"],
        },
      }),
    /Unsupported keys: recursionLimit/,
    "sync settings patches must not accept unrelated backend settings",
  );
});

runCase("requires a concrete layout object", () => {
  assertThrows(
    () => normalizeSyncSettingsPatch({}),
    /requires a layout payload/,
    "sync settings patches should not allow empty payloads",
  );
  assertThrows(
    () => normalizeSyncSettingsPatch({ layout: null }),
    /requires a layout object/,
    "sync settings patches should not allow null layout payloads",
  );
});

console.log("All settings sync patch extreme tests passed.");
