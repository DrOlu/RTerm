import {
  parseMemoryEntries,
  searchMemory,
  appendMemoryNote,
  recallForPrompt,
} from "./memoryManager";

/**
 * memoryManager.extreme.spec — parse, search, dedupe-append-with-cap, recall.
 * Run: npx tsx --test packages/backend/src/memory/memoryManager.extreme.spec.ts
 */

const assert = (c: unknown, m: string): void => {
  if (!c) throw new Error(`assert failed: ${m}`);
};

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

await runCase("parseMemoryEntries extracts bullets/headings/long lines", () => {
  const e = parseMemoryEntries("# Memory\n\n- first note\n- second note about SSH\n\n## Section\nshort\n");
  assert(e.some((x) => x.text === "- first note"), "bullet 1");
  assert(e.some((x) => x.text === "- second note about SSH"), "bullet 2");
  assert(e.some((x) => x.text.startsWith("## Section")), "heading");
  assert(!e.some((x) => x.text === "short"), "tiny lines skipped");
});

await runCase("searchMemory ranks by token overlap", () => {
  const mem = "- fixed the SSH reconnect bug\n- dashboard shows metrics\n- SSH auto-reconnect with backoff shipped\n";
  const hits = searchMemory(mem, "ssh reconnect");
  assert(hits.length >= 1, "found hits");
  assert(hits[0].text.includes("reconnect"), "top hit mentions reconnect");
  assert(hits[0].score >= hits[hits.length - 1].score, "sorted by score desc");
});

await runCase("searchMemory returns [] for empty query", () => {
  assert(searchMemory("- a note\n", "").length === 0, "empty query → no hits");
});

await runCase("appendMemoryNote appends a new note", () => {
  const next = appendMemoryNote("# Memory\n\n- old\n", "- new note");
  assert(next.includes("- old"), "old kept");
  assert(next.includes("- new note"), "new appended");
});

await runCase("appendMemoryNote dedupes an equivalent existing entry", () => {
  const start = "# Memory\n\n- SSH reconnect shipped\n- other\n";
  const next = appendMemoryNote(start, "ssh   reconnect   shipped"); // same, different spacing/case
  const count = (next.match(/reconnect/gi) || []).length;
  assert(count === 1, `expected 1 reconnect mention, got ${count}:\n${next}`);
  assert(next.includes("- other"), "unrelated kept");
});

await runCase("appendMemoryNote enforces the size cap (prunes oldest)", () => {
  let mem = "# Memory\n\n";
  for (let i = 0; i < 200; i += 1) mem += `- entry number ${i} ${"x".repeat(40)}\n`;
  const next = appendMemoryNote(mem, "- brand new entry", { maxChars: 3000 });
  assert(next.length <= 3200, `capped at ~3000, got ${next.length}`);
  assert(next.includes("- brand new entry"), "newest kept");
  assert(next.startsWith("# Memory"), "title preserved");
});

await runCase("recallForPrompt returns whole file when small", () => {
  const mem = "# Memory\n\n- small note\n";
  assert(recallForPrompt(mem) === mem, "small file returned whole");
});

await runCase("recallForPrompt caps a large file to relevant entries", () => {
  let mem = "# Memory\n\n";
  for (let i = 0; i < 300; i += 1) mem += `- note ${i} about topic${i % 5} with padding ${"y".repeat(60)}\n`;
  mem += "- critical fix for the SSH reconnect race\n";
  const recalled = recallForPrompt(mem, { query: "ssh reconnect race", maxChars: 4000 });
  assert(recalled.length <= 4000, `recall capped, got ${recalled.length}`);
  assert(recalled.includes("SSH reconnect race"), "relevant entry recalled");
  assert(recalled.length < mem.length, "recall smaller than full file");
});

await runCase("recallForPrompt with no query keeps newest entries", () => {
  let mem = "# Memory\n\n";
  for (let i = 0; i < 300; i += 1) mem += `- entry ${i} ${"z".repeat(60)}\n`;
  mem += "- the very latest note\n";
  const recalled = recallForPrompt(mem, { maxChars: 3000 });
  assert(recalled.includes("very latest note"), "newest kept without query");
});

console.log("memoryManager: all cases passed");
