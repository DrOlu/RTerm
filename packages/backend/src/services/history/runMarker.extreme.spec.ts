/**
 * Run interruption markers (v3.8.9).
 *
 * THE PROBLEM (found live): a force quit mid-run leaves the session's last
 * AI message PARTIAL, but it is stored looking exactly like a completed
 * turn. After restart the model reads it as complete and treats the user's
 * next message as a fresh topic — the interrupted task is silently
 * abandoned instead of continued.
 *
 * THE FIX: a marker set at run start and cleared in the run's finally.
 * Only a hard kill (force quit / crash / power loss) skips finally, so a
 * leftover marker is a durable, restart-surviving interruption record.
 * The restore path detects it and injects a SystemMessage notice so the
 * model KNOWS the previous turn was cut off.
 *
 * These cases pin the storage lifecycle (set/get/clear/survives-restart)
 * and the consumption semantics. The AgentService injection itself is
 * integration-level (needs the full graph); this pins the contract it
 * depends on.
 *
 * Run:  npx tsx packages/backend/src/services/history/runMarker.extreme.spec.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatHistoryService } from "../ChatHistoryService";
import { HistorySqliteStore } from "./HistorySqliteStore";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const assertNull = (actual: unknown, message: string): void => {
  if (actual !== null) {
    throw new Error(`${message}. expected=null actual=${String(actual)}`);
  }
};

let passed = 0;
const runCase = (name: string, fn: () => void): void => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

const withServices = (
  fn: (svc: ChatHistoryService, store: HistorySqliteStore, dir: string) => void,
): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gyshell-runmarker-"));
  const store = new HistorySqliteStore({ filePath: path.join(dir, "history.sqlite") });
  const svc = new ChatHistoryService({ store });
  try {
    fn(svc, store, dir);
  } finally {
    store.close();
  }
};

// ─── lifecycle ───────────────────────────────────────────────────────────────

runCase("marker is absent before any run", () => {
  withServices((svc) => {
    assertNull(svc.getRunMarker("s-1"), "no marker before a run");
  });
});

runCase("setRunMarker then getRunMarker round-trips the payload", () => {
  withServices((svc) => {
    svc.setRunMarker("s-1", {
      runId: "run-abc",
      startedAt: 1789700000000,
      inputPreview: "deploy the thing",
    });
    const m = svc.getRunMarker("s-1")!;
    assertEqual(m.runId, "run-abc", "runId round-trips");
    assertEqual(m.startedAt, 1789700000000, "startedAt round-trips");
    assertEqual(m.inputPreview, "deploy the thing", "inputPreview round-trips");
  });
});

runCase("clearRunMarker removes the marker (the graceful-run path)", () => {
  withServices((svc) => {
    svc.setRunMarker("s-1", { runId: "r1", startedAt: 1 });
    svc.clearRunMarker("s-1");
    assertNull(svc.getRunMarker("s-1"), "cleared marker reads as absent");
  });
});

// ─── THE POINT: survives a restart ───────────────────────────────────────────

runCase("a leftover marker SURVIVES a store close+reopen (the force-quit case)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gyshell-runmarker-restart-"));
  const dbPath = path.join(dir, "history.sqlite");

  // Process A: run starts (marker set), then the app is force-killed —
  // no finally, no clearRunMarker.
  const storeA = new HistorySqliteStore({ filePath: dbPath });
  const svcA = new ChatHistoryService({ store: storeA });
  svcA.setRunMarker("s-kill", {
    runId: "run-killed",
    startedAt: Date.now() - 60000,
    inputPreview: "the interrupted task",
  });
  storeA.close(); // hard stop — nothing else runs

  // Process B: a fresh process reopens the same database.
  const storeB = new HistorySqliteStore({ filePath: dbPath });
  const svcB = new ChatHistoryService({ store: storeB });
  const m = svcB.getRunMarker("s-kill");
  if (!m) throw new Error("the marker must survive a restart — this is the entire feature");
  assertEqual(m.runId, "run-killed", "runId survives the restart");
  assertEqual(m.inputPreview, "the interrupted task", "inputPreview survives the restart");
  storeB.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── consumption + robustness ───────────────────────────────────────────────

runCase("markers are per-session (one session's marker does not leak to another)", () => {
  withServices((svc) => {
    svc.setRunMarker("s-a", { runId: "ra", startedAt: 1 });
    assertNull(svc.getRunMarker("s-b"), "another session has no marker");
    svc.clearRunMarker("s-b"); // clearing an absent marker is a no-op
    assertEqual(svc.getRunMarker("s-a")?.runId, "ra", "s-a's marker untouched");
  });
});

runCase("a corrupt marker reads as absent (never throws on restore)", () => {
  withServices((svc, store) => {
    store.setMeta("run-marker:s-corrupt", "{not json at all");
    assertNull(svc.getRunMarker("s-corrupt"), "corrupt marker is treated as absent");
    // And a marker missing runId is also invalid:
    store.setMeta("run-marker:s-shape", JSON.stringify({ noRunId: true }));
    assertNull(svc.getRunMarker("s-shape"), "shape-invalid marker is treated as absent");
  });
});

runCase("clear-then-set (consecutive runs) leaves only the newest marker", () => {
  withServices((svc) => {
    svc.setRunMarker("s-1", { runId: "first", startedAt: 1 });
    svc.clearRunMarker("s-1"); // first run ended gracefully
    svc.setRunMarker("s-1", { runId: "second", startedAt: 2 }); // second run started
    assertEqual(svc.getRunMarker("s-1")?.runId, "second", "only the newest marker remains");
  });
});

console.log(`\n${passed} passed, 0 failed`);
console.log("runMarker: ALL TESTS PASSED");
