import { ChunkedRingBuffer } from "./chunkedRingBuffer";

/**
 * chunkedRingBuffer.extreme.spec — append, eviction, offset monotonicity, content integrity.
 * Run: npx tsx --test packages/backend/src/services/terminal/chunkedRingBuffer.extreme.spec.ts
 */

const assert = (c: unknown, m: string): void => {
  if (!c) throw new Error(`assert failed: ${m}`);
};

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

await runCase("append accumulates content + offset", () => {
  const b = new ChunkedRingBuffer({ maxSize: 1000, chunkSize: 256 });
  b.append("hello ");
  b.append("world");
  assert(b.content() === "hello world", "content joined");
  assert(b.offset === 11, "offset = total appended");
  assert(b.size() === 11, "size = retained");
});

await runCase("evicts oldest whole chunks on overflow", () => {
  const b = new ChunkedRingBuffer({ maxSize: 100, chunkSize: 40 });
  // Write 3 full chunks (120 chars) → over maxSize 100 → oldest evicted.
  b.append("A".repeat(40));
  b.append("B".repeat(40));
  b.append("C".repeat(40));
  assert(b.size() <= 100, `size ${b.size()} <= 100`);
  const c = b.content();
  assert(c.endsWith("C".repeat(40)), "newest chunk retained");
  assert(b.offset === 120, "offset tracks all appends even after eviction");
});

await runCase("content() always reflects retained tail after many appends", () => {
  const b = new ChunkedRingBuffer({ maxSize: 50, chunkSize: 10 });
  for (let i = 0; i < 50; i += 1) b.append(`${i % 10}`); // 50 chars
  b.append("XYZ"); // +3 → evict
  const c = b.content();
  assert(c.endsWith("XYZ"), "tail present");
  assert(b.size() <= 50, "capped");
  assert(b.offset === 53, "offset monotonic");
});

await runCase("offset is monotonic even under heavy eviction", () => {
  const b = new ChunkedRingBuffer({ maxSize: 20, chunkSize: 8 });
  let total = 0;
  for (let i = 0; i < 100; i += 1) {
    const s = `chunk${i}-`;
    b.append(s);
    total += s.length;
  }
  assert(b.offset === total, "offset === total ever appended");
  assert(b.size() <= 20, "retained capped");
});

await runCase("a single append larger than maxSize keeps only the tail", () => {
  const b = new ChunkedRingBuffer({ maxSize: 30, chunkSize: 8 });
  b.append("Z".repeat(100));
  assert(b.size() <= 30, `size ${b.size()} <= 30`);
  assert(b.content() === "Z".repeat(b.size()), "only Zs retained");
  assert(b.offset === 100, "offset = 100");
});

await runCase("clear resets everything", () => {
  const b = new ChunkedRingBuffer({ maxSize: 50, chunkSize: 10 });
  b.append("hello");
  b.clear();
  assert(b.content() === "", "empty");
  assert(b.offset === 0, "offset reset");
  assert(b.size() === 0, "size reset");
});

await runCase("empty append is a no-op", () => {
  const b = new ChunkedRingBuffer({ maxSize: 50 });
  b.append("");
  assert(b.offset === 0 && b.size() === 0, "nothing appended");
});

console.log("chunkedRingBuffer: all cases passed");
