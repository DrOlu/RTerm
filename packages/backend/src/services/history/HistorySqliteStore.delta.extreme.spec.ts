/**
 * HistorySqliteStore — incremental save (delta) correctness.
 *
 * The incremental path replaced `DELETE ALL` + `INSERT ALL` with "write only
 * the rows that moved". That is only safe if "unchanged" is judged on the FULL
 * serialized body. An earlier revision fingerprinted `${type}\0substr(json,1,200)`,
 * which MISSES a message that grows past character 200 — exactly what streaming
 * does to the last AI message — so the row was skipped and the persisted history
 * silently stayed STALE.
 *
 * These cases pin that: growth past 200 chars must reach disk, and the
 * incremental path must otherwise match the old full-rewrite semantics
 * (append / remove / reorder / created-at preservation).
 *
 * Run:  npx tsx packages/backend/src/services/history/HistorySqliteStore.delta.extreme.spec.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistorySqliteStore } from "./HistorySqliteStore";
import type { StoredChatSessionRecord } from "./historyTypes";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

let passed = 0;
const runCase = (name: string, fn: () => void): void => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

const withStore = (fn: (store: HistorySqliteStore, dir: string) => void): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gyshell-delta-extreme-"));
  const store = new HistorySqliteStore({
    filePath: path.join(dir, "history.sqlite"),
  });
  try {
    fn(store, dir);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const session = (
  messages: Array<{ id: string; body: string }>,
  overrides: Partial<StoredChatSessionRecord> = {},
): StoredChatSessionRecord => ({
  id: "s-1",
  title: "T",
  messages: messages.map((m) => ({ id: m.id, type: "assistant", data: { c: m.body } })),
  lastCheckpointOffset: 0,
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

const bodyOf = (store: HistorySqliteStore, index: number): string => {
  const loaded = store.loadChatSession("s-1");
  assertCondition(loaded, "session should exist");
  return (loaded!.messages[index].data as { c: string }).c;
};

// ---------------------------------------------------------------- the FN
runCase("growth past char 200 is persisted (prefix digest would skip it)", () => {
  withStore((store) => {
    // 200 identical chars, then grow the tail: the first 200 chars never change.
    const head = "A".repeat(200);
    store.saveChatSession(session([{ id: "m-1", body: head }]));
    assertEqual(bodyOf(store, 0).length, 200, "first save stores 200 chars");

    const grown = `${head}${"B".repeat(300)}`;
    store.saveChatSession(session([{ id: "m-1", body: grown }]));
    assertEqual(
      bodyOf(store, 0).length,
      500,
      "grown body must reach disk, not stay stale at 200",
    );
    assertEqual(
      bodyOf(store, 0).endsWith("B".repeat(300)),
      true,
      "the grown tail must be on disk",
    );
  });
});

// ---------------------------------------------------------------- no-op save
runCase("unchanged body is a no-op and never duplicates rows", () => {
  withStore((store) => {
    const body = "x".repeat(50);
    store.saveChatSession(session([{ id: "m-1", body }, { id: "m-2", body }]));
    store.saveChatSession(session([{ id: "m-1", body }, { id: "m-2", body }]));
    const loaded = store.loadChatSession("s-1")!;
    assertEqual(loaded.messages.length, 2, "row count stays 2 across a no-op save");
    assertEqual(bodyOf(store, 0), body, "body 0 intact");
    assertEqual(bodyOf(store, 1), body, "body 1 intact");
  });
});

// ---------------------------------------------------------------- append
runCase("appended message is written with the next position", () => {
  withStore((store) => {
    store.saveChatSession(session([{ id: "m-1", body: "one" }]));
    store.saveChatSession(
      session([
        { id: "m-1", body: "one" },
        { id: "m-2", body: "two" },
      ]),
    );
    const loaded = store.loadChatSession("s-1")!;
    assertEqual(loaded.messages.length, 2, "append produces 2 rows");
    assertEqual(bodyOf(store, 1), "two", "appended body is on disk");
  });
});

// ---------------------------------------------------------------- removal
runCase("removed message (compaction) is deleted, not left behind", () => {
  withStore((store) => {
    store.saveChatSession(
      session([
        { id: "m-1", body: "one" },
        { id: "m-2", body: "two" },
        { id: "m-3", body: "three" },
      ]),
    );
    // drop the middle message — the classic compaction shape
    store.saveChatSession(
      session([
        { id: "m-1", body: "one" },
        { id: "m-3", body: "three" },
      ]),
    );
    const loaded = store.loadChatSession("s-1")!;
    assertEqual(loaded.messages.length, 2, "removed message is gone");
    assertEqual(loaded.messages[0].id, "m-1", "first id preserved");
    assertEqual(loaded.messages[1].id, "m-3", "second id preserved");
    assertEqual(bodyOf(store, 1), "three", "surviving body intact");
  });
});

// ---------------------------------------------------------------- reorder
runCase("reorder is detected and positions are rewritten correctly", () => {
  withStore((store) => {
    store.saveChatSession(
      session([
        { id: "m-1", body: "one" },
        { id: "m-2", body: "two" },
      ]),
    );
    store.saveChatSession(
      session([
        { id: "m-2", body: "two" },
        { id: "m-1", body: "one" },
      ]),
    );
    const loaded = store.loadChatSession("s-1")!;
    assertEqual(loaded.messages.length, 2, "still 2 rows after reorder");
    assertEqual(loaded.messages[0].id, "m-2", "position 0 is m-2");
    assertEqual(loaded.messages[1].id, "m-1", "position 1 is m-1");
  });
});

// ---------------------------------------------------------------- created_at
runCase("createdAt is preserved across saves (no read-before-write)", () => {
  withStore((store) => {
    store.saveChatSession(session([{ id: "m-1", body: "one" }], { createdAt: 111 }));
    store.saveChatSession(
      session([{ id: "m-1", body: "one" }], { createdAt: 999, updatedAt: 999 }),
    );
    assertEqual(
      store.getChatSessionCreatedAt("s-1"),
      111,
      "original createdAt survives a later save that passes a different value",
    );
  });
});

// ---------------------------------------------------------------- empty session
runCase("emptying a session removes every message (cascade-safe)", () => {
  withStore((store) => {
    store.saveChatSession(session([{ id: "m-1", body: "one" }]));
    store.saveChatSession(session([]));
    const loaded = store.loadChatSession("s-1")!;
    assertCondition(loaded, "session row survives");
    assertEqual(loaded.messages.length, 0, "all messages removed");
  });
});

console.log(`\n${passed} passed, 0 failed`);
console.log("HistorySqliteStore.delta: ALL TESTS PASSED");
