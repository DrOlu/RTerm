/**
 * uiHistoryPersistence.extreme.spec — the v3.4.1 freeze + data-loss fixes.
 *
 * THE TWO BUGS THIS COVERS (found by reading the code after a real incident
 * where a killed process lost a completed agent run):
 *
 *  1. DATA LOSS: recordEvent() marked a session dirty but NEVER flushed.
 *     Messages reached SQLite only on rename/rollback/branch or a graceful
 *     app close. Kill the process mid-run and everything since the last
 *     flush was gone.
 *
 *  2. FREEZE: when flush DID run, saveUiSessions() deleted every row and
 *     re-inserted the entire message list — a large synchronous
 *     better-sqlite3 transaction on the main event loop. On a long session
 *     that is the spinning wheel.
 *
 * NOTE on event shapes: consecutive "say" events MERGE into one streaming
 * assistant message (correct behaviour). To create N separate assistant
 * messages, interleave a user_input between them — exactly like a real
 * conversation.
 *
 * Run: npx tsx packages/backend/src/services/uiHistoryPersistence.extreme.spec.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistorySqliteStore } from "./history/HistorySqliteStore";
import { UIHistoryService } from "./UIHistoryService";
import type { AgentEvent } from "../types";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: unknown, label: string): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

function makeStore(): { store: HistorySqliteStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "uihist-"));
  const store = new HistorySqliteStore({ filePath: join(dir, "h.sqlite") });
  return { store, dir };
}

function userEvent(sessionId: string, content: string, n = 0): AgentEvent {
  return {
    type: "user_input",
    content,
    sessionId,
    // a real backend id so rollbackToMessage can find it (the event field
    // is messageId; processEvent maps it to backendMessageId)
    messageId: `be-${sessionId}-${n}`,
    timestamp: Date.now() + n,
  } as unknown as AgentEvent;
}

function sayEvent(sessionId: string, content: string, n = 0): AgentEvent {
  return {
    type: "say",
    content,
    sessionId,
    timestamp: Date.now() + n,
  } as unknown as AgentEvent;
}

/** One conversation turn = a user message + an assistant reply. */
function recordTurns(
  svc: UIHistoryService,
  sessionId: string,
  turns: number,
): void {
  for (let i = 0; i < turns; i++) {
    svc.recordEvent(sessionId, userEvent(sessionId, `msg ${i}`, i));
    svc.recordEvent(sessionId, sayEvent(sessionId, `answer ${i}`, i + 0.5));
  }
}

async function waitFor(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function run() {
  console.log("== 1. DATA LOSS: messages persist without a graceful close ==");

  {
    const { store, dir } = makeStore();
    const svc = new UIHistoryService({ store });
    recordTurns(svc, "s1", 5); // 5 user + 5 assistant = 10 messages
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);
    const n = store.countUiSessionMessages("s1");
    assert(n === 10, `10 messages auto-persisted after debounce (got ${n})`);
    rmSync(dir, { recursive: true, force: true });
  }

  {
    // Simulate a kill: write, do NOT wait for the debounce, call the
    // shutdown-hook path (flush is what beforeExit/SIGINT call).
    const { store, dir } = makeStore();
    const svc = new UIHistoryService({ store });
    recordTurns(svc, "s2", 3);
    svc.flush();
    const n = store.countUiSessionMessages("s2");
    assert(n === 6, `6 messages survive an immediate shutdown flush (got ${n})`);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n== 2. FREEZE: incremental append, not full rewrite ==");

  {
    const { store, dir } = makeStore();
    const svc = new UIHistoryService({ store });
    recordTurns(svc, "s3", 50); // 100 messages
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);
    assert(store.countUiSessionMessages("s3") === 100, "first flush persisted 100");

    // add ONE more message; the append must write 1 row, not 101
    const before = store.countUiSessionMessages("s3");
    svc.recordEvent("s3", userEvent("s3", "one more", 999));
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);
    const after = store.countUiSessionMessages("s3");
    assert(after === before + 1, `second flush appended exactly 1 row (${before} -> ${after})`);
    assert(after === 101, `total is 101 (got ${after})`);
    rmSync(dir, { recursive: true, force: true });
  }

  {
    // appendUiSessionMessages writes only the slice it is given
    const { store, dir } = makeStore();
    const msgs = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      role: "user" as const,
      type: "text" as const,
      content: `c${i}`,
      timestamp: Date.now() + i,
    }));
    const n1 = store.appendUiSessionMessages("s4", msgs, 0);
    assert(n1 === 20, `append from 0 wrote 20 (got ${n1})`);
    const n2 = store.appendUiSessionMessages("s4", msgs, 20);
    assert(n2 === 0, `append from end writes 0 (got ${n2})`);
    const total = store.countUiSessionMessages("s4");
    assert(total === 20, `no duplicates (total ${total})`);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n== 3. Correctness: append preserves order and content ==");

  {
    const { store, dir } = makeStore();
    const svc = new UIHistoryService({ store });
    recordTurns(svc, "s5", 10); // 20 messages
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);
    recordTurns(svc, "s5", 5); // 10 more = 30 total
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);

    const loaded = store.loadUiSession("s5");
    assert(loaded !== null, "session reloads from disk");
    assert(loaded!.messages.length === 30, `30 messages on disk (got ${loaded!.messages.length})`);
    const contents = loaded!.messages.map((m) => m.content);
    assert(contents[0] === "msg 0", `first message is msg 0 (got ${contents[0]})`);
    assert(contents[29] === "answer 4", `last message is answer 4 (got ${contents[29]})`);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n== 4. Rollback resets the append cursor ==");

  {
    const { store, dir } = makeStore();
    const svc = new UIHistoryService({ store });
    recordTurns(svc, "s6", 5); // 10 messages
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);
    assert(store.countUiSessionMessages("s6") === 10, "10 persisted before rollback");

    const session = svc.getSession("s6")!;
    assert(session.messages.length === 10, `10 in memory (got ${session.messages.length})`);
    // roll back to the 5th message: rollback removes it AND everything
    // after it, so 10 - 4 = 6 removed, 4 remain.
    const target = session.messages[4];
    assert(!!target.backendMessageId, "target has a backendMessageId");
    const removed = svc.rollbackToMessage("s6", target.backendMessageId!);
    assert(removed === 6, `rollback removed 6 (got ${removed})`);
    const after = store.countUiSessionMessages("s6");
    assert(after === 4, `disk has 4 after rollback (got ${after})`);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n== 5. Delete clears the cursor ==");

  {
    const { store, dir } = makeStore();
    const svc = new UIHistoryService({ store });
    recordTurns(svc, "s7", 3);
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);
    assert(store.countUiSessionMessages("s7") === 6, "6 persisted");
    svc.deleteSessions(["s7"]);
    assert(store.countUiSessionMessages("s7") === 0, "0 after delete");
    recordTurns(svc, "s7", 1);
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);
    assert(store.countUiSessionMessages("s7") === 2, `2 after recreate (got ${store.countUiSessionMessages("s7")})`);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n== 6. Restart: loaded sessions append, never duplicate ==");

  {
    const { store, dir } = makeStore();
    const svc = new UIHistoryService({ store });
    recordTurns(svc, "s8", 4); // 8 messages
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);

    // NEW service instance over the same DB = an app restart
    const svc2 = new UIHistoryService({ store });
    recordTurns(svc2, "s8", 2); // 4 more = 12 total
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);
    const total = store.countUiSessionMessages("s8");
    assert(total === 12, `restart + append = 12, no dupes (got ${total})`);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n== 7. Streaming burst merges then persists (correct behaviour) ==");

  {
    const { store, dir } = makeStore();
    const svc = new UIHistoryService({ store });
    // 50 rapid "say" deltas: consecutive deltas MERGE into ONE streaming
    // assistant message — that is correct, not a bug.
    for (let i = 0; i < 50; i++) {
      svc.recordEvent("s9", sayEvent("s9", `chunk ${i} `, i));
    }
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);
    const total = store.countUiSessionMessages("s9");
    assert(total === 1, `50 deltas merged into 1 streaming message (got ${total})`);
    const loaded = store.loadUiSession("s9");
    const content = loaded?.messages[0]?.content ?? "";
    assert(content.includes("chunk 49"), `merged content has the last delta (len ${content.length})`);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n== 8. Large session: append stays fast (the freeze fix) ==");

  {
    const { store, dir } = makeStore();
    const svc = new UIHistoryService({ store });
    // 500 user messages with 2KB content each = ~1MB session
    for (let i = 0; i < 500; i++) {
      svc.recordEvent("s10", userEvent("s10", "x".repeat(2048) + ` ${i}`, i));
    }
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);
    const t0 = Date.now();
    svc.recordEvent("s10", userEvent("s10", "one more", 999));
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);
    const elapsed = Date.now() - t0;
    const total = store.countUiSessionMessages("s10");
    assert(total === 501, `501 persisted (got ${total})`);
    assert(elapsed < 2500, `append flush on a 500-message session took ${elapsed}ms (< 2500)`);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("FAILURES:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log("uiHistoryPersistence: ALL TESTS PASSED");
}

run().catch((e) => {
  console.error("spec crashed:", e);
  process.exit(1);
});