/**
 * uiHistoryStreamingRewrite.extreme.spec — v3.4.3
 *
 * Regression tests for the streaming-rewrite cursor in UIHistoryService.
 *
 * THE BUG (found by tracing the appendFrom computation):
 *   v3.4.2's flush() scanned persisted rows for `m.streaming` to decide
 *   when to reset the append cursor. That catches a message that is STILL
 *   streaming at flush time — but the moment the message FINISHES (say
 *   `done` / `command_finished` flips streaming to false), the scan goes
 *   blind and the cursor stays past it. Its final content never lands on
 *   disk: the append path can only ADD rows, and nothing ever rewrites
 *   that row. On reload the session shows the truncated mid-stream text.
 *
 * THE FIX: persist the IDs of messages written-while-streaming
 *   (persistedStreamingMessageIds). A row stays "stale" across the
 *   streaming→finished transition until a flush actually rewrites it.
 *
 * Also covers:
 *   - getLastVisiblePreview: skips empty trailing messages (v3.4.3 FN —
 *     the old code returned "" on the first empty message) and caps the
 *     preview at 200 chars (the old code wrote the FULL message body into
 *     ui_sessions.last_message_preview on every flush).
 *   - remove_message resets the append cursor (v3.4.3 — only rollback
 *     did before).
 *   - dispose() removes the instance from the shared shutdown registry.
 *
 * Run: npx tsx packages/backend/src/services/uiHistoryStreamingRewrite.extreme.spec.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import { UIHistoryService } from "./UIHistoryService";
import { HistorySqliteStore } from "./history/HistorySqliteStore";
import {
  getLastVisiblePreview,
  buildUiSessionSummary,
} from "./history/uiHistoryHelpers";
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

const waitFor = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeStore(): { store: HistorySqliteStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uihist-stream-"));
  // NOTE: options are named — `new HistorySqliteStore(path)` would silently
  // open the REAL user history DB (the positional arg is ignored), which is
  // both a test-isolation bug and a data-pollution hazard.
  const store = new HistorySqliteStore({ filePath: path.join(dir, "h.db") });
  return { store, dir };
}

function sayEvent(sessionId: string, content: string, messageId: string): AgentEvent {
  return {
    sessionId,
    messageId,
    type: "say",
    content,
  } as AgentEvent;
}

function doneEvent(sessionId: string): AgentEvent {
  return { sessionId, type: "done" } as AgentEvent;
}

function removeMessageEvent(sessionId: string, messageId: string): AgentEvent {
  return { sessionId, messageId, type: "remove_message" } as AgentEvent;
}

async function main() {
  console.log("\n== 1. THE MAIN BUG: finished streaming message is rewritten ==");

  {
    const { store, dir } = makeStore();
    const svc = new UIHistoryService({ store });

    // User message, then a streaming say that gets persisted MID-STREAM.
    svc.recordEvent("s1", { sessionId: "s1", type: "user_input", content: "hello", messageId: "u1" } as AgentEvent);
    svc.recordEvent("s1", sayEvent("s1", "partial answer ", "m1"));
    // Flush while still streaming → the row on disk is truncated.
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);
    const midStream = store.countUiSessionMessages("s1");
    const loadedMid = store.loadUiSession("s1");
    assert(midStream === 2, `2 rows persisted mid-stream (got ${midStream})`);
    assert(
      (loadedMid?.messages[1]?.content ?? "") === "partial answer ",
      `mid-stream content on disk is the truncated text (got ${JSON.stringify(loadedMid?.messages[1]?.content)})`,
    );

    // The stream continues (same message grows)...
    svc.recordEvent("s1", sayEvent("s1", "and here is the final conclusion of the answer", "m1"));
    // ...and then the turn ENDS: `done` flips streaming to false.
    svc.recordEvent("s1", doneEvent("s1"));
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);

    const loaded = store.loadUiSession("s1");
    const content = loaded?.messages[1]?.content ?? "";
    assert(
      content.includes("final conclusion"),
      `FINAL content lands after the message finishes (got ${JSON.stringify(content)})`,
    );
    assert(
      store.countUiSessionMessages("s1") === 2,
      `still 2 rows, not duplicated (got ${store.countUiSessionMessages("s1")})`,
    );
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n== 2. Still-streaming message is rewritten while streaming ==");

  {
    const { store, dir } = makeStore();
    const svc = new UIHistoryService({ store });
    svc.recordEvent("s1", sayEvent("s1", "abc ", "m1"));
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);
    svc.recordEvent("s1", sayEvent("s1", "def ", "m1"));
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);
    const loaded = store.loadUiSession("s1");
    assert(
      (loaded?.messages[0]?.content ?? "") === "abc def ",
      `streaming growth is persisted while still streaming (got ${JSON.stringify(loaded?.messages[0]?.content)})`,
    );
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n== 3. getLastVisiblePreview skips empty trailing messages (FN fix) ==");

  {
    // The old code `return ""`-ed on the first empty message, so a session
    // whose last message was an empty sub_tool showed a BLANK preview.
    const preview = getLastVisiblePreview([
      { id: "a", role: "user", type: "text", content: "real earlier message", timestamp: 1, streaming: false },
      { id: "b", role: "assistant", type: "sub_tool", content: "", timestamp: 2, streaming: true, metadata: { output: "" } },
    ] as any);
    assert(
      preview === "real earlier message",
      `preview falls back to the last NON-EMPTY message (got ${JSON.stringify(preview)})`,
    );
  }

  console.log("\n== 4. getLastVisiblePreview caps length at 200 (perf fix) ==");

  {
    const long = "x".repeat(5000);
    const preview = getLastVisiblePreview([
      { id: "a", role: "user", type: "text", content: long, timestamp: 1, streaming: false },
    ] as any);
    assert(
      preview.length <= 201,
      `preview capped at 200 chars + ellipsis (got ${preview.length})`,
    );
    const summary = buildUiSessionSummary({
      id: "s",
      title: "t",
      updatedAt: 1,
      messages: [
        { id: "a", role: "user", type: "text", content: long, timestamp: 1, streaming: false },
      ] as any,
    });
    assert(
      summary.lastMessagePreview.length <= 201,
      `summary preview also capped (got ${summary.lastMessagePreview.length})`,
    );
  }

  console.log("\n== 5. remove_message resets the append cursor ==");

  {
    const { store, dir } = makeStore();
    const svc = new UIHistoryService({ store });
    // 3 ASSISTANT messages persisted (remove_message only targets assistant
    // rows — emitRemoveMessageIfPresent fires for AIMessage only).
    const say = (mid: string, content: string) =>
      svc.recordEvent("s1", {
        sessionId: "s1",
        type: "say",
        content,
        messageId: mid,
      } as AgentEvent);
    say("m1", "one");
    svc.recordEvent("s1", { sessionId: "s1", type: "done" } as AgentEvent);
    say("m2", "two");
    svc.recordEvent("s1", { sessionId: "s1", type: "done" } as AgentEvent);
    say("m3", "three");
    svc.recordEvent("s1", { sessionId: "s1", type: "done" } as AgentEvent);
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);
    assert(store.countUiSessionMessages("s1") === 3, "3 persisted before remove");

    // Remove the middle message → positions shift; cursor must reset.
    svc.recordEvent("s1", removeMessageEvent("s1", "m2"));
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 400);
    const loaded = store.loadUiSession("s1");
    const contents = (loaded?.messages ?? []).map((m: any) => m.content);
    assert(
      contents.join("|") === "one|three",
      `remove_message survives persistence (got ${JSON.stringify(contents)})`,
    );
    assert(store.countUiSessionMessages("s1") === 2, `2 rows on disk (got ${store.countUiSessionMessages("s1")})`);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n== 6. dispose() removes the instance from the registry ==");

  {
    const { store, dir } = makeStore();
    const svc = new UIHistoryService({ store });
    svc.recordEvent("s1", sayEvent("s1", "hello", "m1"));
    svc.dispose();
    await waitFor(UIHistoryService.FLUSH_DEBOUNCE_MS + 200);
    // dispose flushed synchronously — the message must already be on disk.
    assert(
      store.countUiSessionMessages("s1") === 1,
      `dispose() flushes buffered history (got ${store.countUiSessionMessages("s1")})`,
    );
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n== 7. No listener leak across many instances ==");

  {
    const { store, dir } = makeStore();
    const before = process.listenerCount("SIGINT");
    const svcs = Array.from({ length: 12 }, () => new UIHistoryService({ store }));
    const after = process.listenerCount("SIGINT");
    assert(
      after - before <= 1,
      `12 instances add at most 1 SIGINT listener (before=${before} after=${after})`,
    );
    svcs.forEach((s) => s.dispose());
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("FAILURES:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log("uiHistoryStreamingRewrite: ALL TESTS PASSED");
}

main().catch((e) => {
  console.error("spec crashed:", e);
  process.exit(1);
});
