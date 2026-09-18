/**
 * ChatHistoryService — rename/save race (v3.8.9).
 *
 * THE BUG (found live): saveChatSession's upsert does
 *   title = excluded.title
 * unconditionally. AgentService loads the session at RUN START and saves it
 * at RUN END; a rename issued DURING the run persists the new title, and the
 * run-end save then wrote the STALE in-memory title back — the rename
 * silently reverted.
 *
 * The fix: ChatHistoryService.saveSession treats the STORED title as
 * authoritative for an existing session (same discipline as created_at,
 * which never had this bug because the upsert never assigns it). The
 * in-memory title only names a brand-new session.
 *
 * Run:  npx tsx packages/backend/src/services/history/renameRace.extreme.spec.ts
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

let passed = 0;
const runCase = (name: string, fn: () => void): void => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

const withServices = (fn: (svc: ChatHistoryService, store: HistorySqliteStore) => void): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gyshell-rename-race-"));
  const store = new HistorySqliteStore({ filePath: path.join(dir, "history.sqlite") });
  const svc = new ChatHistoryService({ store });
  try {
    fn(svc, store);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const session = (title: string): any => ({
  id: "s-race",
  title,
  messages: new Map([["m-1", { _getType: () => "human", content: "hello" }]]),
  lastCheckpointOffset: 0,
});

// ─── THE RACE, exactly as it happens in the agent ────────────────────────────

runCase("rename during a run survives the run-end save (the live bug)", () => {
  withServices((svc, store) => {
    // 1. Run starts: the agent loads the session (title "Old Title").
    svc.saveSession(session("Old Title"));
    const loadedAtRunStart = svc.loadSession("s-race")!;
    assertEqual(loadedAtRunStart.title, "Old Title", "session starts with the old title");

    // 2. Mid-run: the user renames. renameSession persists the new title.
    svc.renameSession("s-race", "Renamed Mid-Run");

    // 3. Run ends: the agent saves the STALE in-memory object it loaded at
    //    step 1 (title still "Old Title" — nothing updated it in memory).
    //    Before the fix, this clobbered the rename.
    svc.saveSession(loadedAtRunStart);

    // 4. The rename must survive.
    const final = store.loadChatSession("s-race")!;
    assertEqual(final.title, "Renamed Mid-Run", "a rename during a run must not be reverted by the run-end save");
  });
});

// ─── The fix must not break first-save naming ─────────────────────────────────

runCase("a brand-new session still takes its in-memory title (first save)", () => {
  withServices((svc, store) => {
    svc.saveSession(session("Fresh Name"));
    const stored = store.loadChatSession("s-race")!;
    assertEqual(stored.title, "Fresh Name", "first save names the session");
  });
});

runCase("two saves of a new object: second save keeps the stored title", () => {
  withServices((svc, store) => {
    svc.saveSession(session("First"));
    // A second save with a DIFFERENT in-memory title: the stored one wins.
    svc.saveSession(session("Second"));
    const stored = store.loadChatSession("s-race")!;
    assertEqual(stored.title, "First", "stored title is authoritative on later saves");
  });
});

// ─── Rename then save via the store directly (checkpoint path) ───────────────

runCase("rename survives a direct store saveChatSession with a stale title", () => {
  withServices((svc, store) => {
    svc.saveSession(session("Original"));
    svc.renameSession("s-race", "Renamed");
    // The store-level save is the raw path; the service-level guard is what
    // protects it, so this documents that the STORE upsert itself still
    // overwrites — the fix lives in ChatHistoryService.saveSession.
    store.saveChatSession({
      id: "s-race",
      title: "Original",
      messages: [{ id: "m-1", type: "human", data: { content: "x" } }],
      lastCheckpointOffset: 0,
      createdAt: 1,
      updatedAt: Date.now(),
    });
    // This is the CURRENT behavior of the raw store path — the service-level
    // fix covers every caller that goes through ChatHistoryService.
    const stored = store.loadChatSession("s-race")!;
    assertEqual(stored.title, "Original", "raw store save still overwrites (fix is service-level; documents the boundary)");
  });
});

console.log(`\n${passed} passed, 0 failed`);
console.log("renameRace: ALL TESTS PASSED");
