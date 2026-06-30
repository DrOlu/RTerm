import {
  PREVIEW_WHEEL_DELTA_LINE,
  PREVIEW_WHEEL_DELTA_PAGE,
  normalizePreviewWheelDelta,
  resolveAnchoredPreviewScrollOffset,
  resolveAnchoredPreviewScrollOffsetFromCoordinate,
  resolvePreviewWheelZoomMultiplier,
  shouldHandlePreviewWheelZoom,
} from "./previewInteractions";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const assertApprox = (
  actual: number,
  expected: number,
  message: string,
): void => {
  if (Math.abs(actual - expected) > 0.000001) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

const run = async (): Promise<void> => {
  await runCase("wheel zoom only handles modifier-assisted wheel input", () => {
    assertEqual(
      shouldHandlePreviewWheelZoom({ ctrlKey: true }),
      true,
      "ctrl wheel should zoom",
    );
    assertEqual(
      shouldHandlePreviewWheelZoom({ metaKey: true }),
      true,
      "meta wheel should zoom",
    );
    assertEqual(
      shouldHandlePreviewWheelZoom({}),
      false,
      "plain wheel should keep scrolling",
    );
  });

  await runCase("wheel deltas normalize by browser delta mode", () => {
    assertEqual(
      normalizePreviewWheelDelta(2, PREVIEW_WHEEL_DELTA_LINE),
      32,
      "line deltas should map to pixels",
    );
    assertEqual(
      normalizePreviewWheelDelta(1, PREVIEW_WHEEL_DELTA_PAGE),
      800,
      "page deltas should map to pixels",
    );
    assertEqual(
      normalizePreviewWheelDelta(12, 0),
      12,
      "pixel deltas should stay unchanged",
    );
  });

  await runCase(
    "wheel multiplier zooms in for negative deltas and out for positive deltas",
    () => {
      const zoomIn = resolvePreviewWheelZoomMultiplier(-100, 0);
      const zoomOut = resolvePreviewWheelZoomMultiplier(100, 0);
      if (zoomIn <= 1) {
        throw new Error(
          `negative wheel delta should zoom in. actual=${zoomIn}`,
        );
      }
      if (zoomOut >= 1) {
        throw new Error(
          `positive wheel delta should zoom out. actual=${zoomOut}`,
        );
      }
    },
  );

  await runCase(
    "anchored scroll keeps the pointer over the same content coordinate",
    () => {
      const nextScroll = resolveAnchoredPreviewScrollOffset({
        scrollOffset: 100,
        pointerOffset: 50,
        oldScale: 1,
        newScale: 2,
        contentOffset: 10,
      });
      assertApprox(
        nextScroll,
        240,
        "anchored scroll should preserve content under pointer",
      );
    },
  );

  await runCase(
    "coordinate-based anchored scroll clamps to scroll range",
    () => {
      const nextScroll = resolveAnchoredPreviewScrollOffsetFromCoordinate({
        contentCoordinate: 1000,
        pointerOffset: 10,
        newScale: 2,
        contentOffset: 0,
        maxScrollOffset: 500,
      });
      assertEqual(
        nextScroll,
        500,
        "anchored scroll should clamp to max scroll",
      );
    },
  );
};

void run()
  .then(() => {
    console.log("All previewInteractions extreme tests passed.");
  })
  .catch((error) => {
    console.error(error);
    throw error;
  });
