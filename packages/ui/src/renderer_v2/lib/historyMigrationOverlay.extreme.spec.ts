import assert from "node:assert/strict";
import { shouldShowHistoryMigrationOverlay } from "./historyMigrationOverlay";

assert.equal(
  shouldShowHistoryMigrationOverlay(null),
  false,
  "missing state should not render the overlay",
);

assert.equal(
  shouldShowHistoryMigrationOverlay({
    status: "idle",
    ready: false,
    detectedLegacy: false,
  }),
  false,
  "plain startup barrier state should stay hidden before legacy detection",
);

assert.equal(
  shouldShowHistoryMigrationOverlay({
    status: "running",
    ready: false,
    detectedLegacy: false,
  }),
  false,
  "startup finalization without legacy migration should not render the overlay",
);

assert.equal(
  shouldShowHistoryMigrationOverlay({
    status: "running",
    ready: false,
    detectedLegacy: true,
  }),
  true,
  "active legacy migration should keep the overlay visible",
);

assert.equal(
  shouldShowHistoryMigrationOverlay({
    status: "done",
    ready: true,
    detectedLegacy: true,
  }),
  false,
  "completed migration should dismiss the overlay once startup settles",
);

assert.equal(
  shouldShowHistoryMigrationOverlay({
    status: "error",
    ready: false,
    detectedLegacy: false,
  }),
  true,
  "startup errors should still remain visible",
);

console.log("historyMigrationOverlay.extreme.spec.ts passed");
