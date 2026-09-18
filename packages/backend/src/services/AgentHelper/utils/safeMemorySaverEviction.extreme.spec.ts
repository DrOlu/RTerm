/**
 * safeMemorySaver — checkpoint eviction tests (v3.8.9).
 *
 * THE FREEZE ROOT CAUSE (found by reading @langchain/langgraph-checkpoint's
 * MemorySaver): storage[threadId][ns][checkpoint.id] keeps EVERY checkpoint
 * of EVERY graph step, forever. A 100-step multi-tool run retains 100
 * serialized copies of the full conversation state in RAM. SafeMemorySaver
 * pruned the CONTENTS of each blob but never EVICTED old ones — unbounded
 * growth, GC thrash, and the UI freezes in extended chats.
 *
 * The fix: after each put, keep only the newest CHECKPOINT_RETENTION
 * checkpoints per (thread, ns). LangGraph resumes from the LATEST checkpoint
 * (getTuple with no checkpoint_id), and parent chain walking only needs the
 * last few, so retaining the newest handful is safe.
 *
 * Run:  npx tsx packages/backend/src/services/AgentHelper/utils/safeMemorySaverEviction.extreme.spec.ts
 */
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import {
  CHECKPOINT_RETENTION,
  SafeMemorySaver,
} from "./safeMemorySaver";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

let passed = 0;
const runCase = (name: string, fn: () => void | Promise<void>): Promise<void> | void => {
  const r = fn();
  if (r instanceof Promise) {
    return r.then(() => {
      passed += 1;
      console.log(`PASS ${name}`);
    });
  }
  passed += 1;
  console.log(`PASS ${name}`);
};

const cfg = (threadId: string, ns = "") => ({
  configurable: { thread_id: threadId, checkpoint_ns: ns },
});

const mkCheckpoint = (id: string, text: string): any => ({
  id,
  v: 1,
  ts: `ts-${id}`,
  channel_values: { messages: [{ type: "ai", content: text }] },
});

// ─── eviction ────────────────────────────────────────────────────────────────

await runCase("retention constant is a sane small number", () => {
  assertEqual(typeof CHECKPOINT_RETENTION, "number", "retention is a number");
  assertEqual(CHECKPOINT_RETENTION >= 3 && CHECKPOINT_RETENTION <= 20, true,
    `retention between 3 and 20 (got ${CHECKPOINT_RETENTION})`);
});

await runCase("put() evicts old checkpoints beyond the retention window", async () => {
  const saver = new SafeMemorySaver();
  const thread = "evict-test-1";
  const total = 50;
  for (let i = 0; i < total; i++) {
    await saver.put(cfg(thread), mkCheckpoint(`cp-${i}`, `state ${i}`), { step: i });
  }
  // Reach into the inherited storage the way MemorySaver does.
  const storage = (saver as any).storage as Record<string, Record<string, Record<string, unknown>>>;
  const ids = Object.keys(storage[thread][""] ?? {});
  assertEqual(ids.length, CHECKPOINT_RETENTION,
    `after ${total} puts, exactly CHECKPOINT_RETENTION checkpoints remain`);
  // The NEWEST ones must be the survivors.
  const kept = ids.sort();
  assertEqual(kept[kept.length - 1], `cp-${total - 1}`, "the newest checkpoint survives");
  assertEqual(kept.includes("cp-0"), false, "the oldest checkpoint is evicted");
});

await runCase("eviction is per-thread (one busy thread does not evict another's history)", async () => {
  const saver = new SafeMemorySaver();
  const a = "thread-a", b = "thread-b";
  for (let i = 0; i < 30; i++) {
    await saver.put(cfg(a), mkCheckpoint(`a-${i}`, "x"), {});
  }
  await saver.put(cfg(b), mkCheckpoint("b-0", "y"), {});
  const storage = (saver as any).storage;
  const aIds = Object.keys(storage[a][""] ?? {});
  const bIds = Object.keys(storage[b][""] ?? {});
  assertEqual(aIds.length, CHECKPOINT_RETENTION, "thread a is capped");
  assertEqual(bIds.length, 1, "thread b is untouched by thread a's churn");
});

await runCase("getTuple still resolves the LATEST checkpoint after eviction", async () => {
  const saver = new SafeMemorySaver();
  const thread = "resume-test";
  for (let i = 0; i < 40; i++) {
    await saver.put(cfg(thread), mkCheckpoint(`cp-${i}`, `state ${i}`), {});
  }
  const tuple = await saver.getTuple(cfg(thread));
  assertEqual(tuple?.checkpoint?.id, "cp-39", "resume finds the newest checkpoint after eviction");
});

await runCase("deleteThread still clears everything", async () => {
  const saver = new SafeMemorySaver();
  const thread = "del-test";
  for (let i = 0; i < 10; i++) {
    await saver.put(cfg(thread), mkCheckpoint(`cp-${i}`, "x"), {});
  }
  await saver.deleteThread(thread);
  const storage = (saver as any).storage;
  assertEqual(storage[thread], undefined, "deleteThread removes the thread");
});

await runCase("plain MemorySaver would have kept all 50 (the bug, documented)", async () => {
  const saver = new MemorySaver();
  const thread = "bug-demo";
  for (let i = 0; i < 50; i++) {
    // The vanilla saver's put() types metadata as CheckpointMetadata; the
    // empty object is fine at runtime, it just needs the cast for tsc.
    await saver.put(cfg(thread), mkCheckpoint(`cp-${i}`, "x"), {} as never);
  }
  const storage = (saver as any).storage;
  const ids = Object.keys(storage[thread][""] ?? {});
  assertEqual(ids.length, 50, "vanilla MemorySaver retains every checkpoint — this is the leak SafeMemorySaver now caps");
});

console.log(`\n${passed} passed, 0 failed`);
console.log("safeMemorySaverEviction: ALL TESTS PASSED");
