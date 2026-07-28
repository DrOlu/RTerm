import {
  userMessageIds,
  anchorFor,
  resolveUserMessageNavTarget,
} from "./userMessageNav";

/**
 * userMessageNav.extreme.spec — anchors + prev/next/latest navigation.
 * Run: npx tsx --test packages/ui/src/renderer_v2/components/Chat/userMessageNav.extreme.spec.ts
 */

const assert = (c: unknown, m: string): void => {
  if (!c) throw new Error(`assert failed: ${m}`);
};

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

const roles: Record<string, string> = {
  m1: "user", m2: "assistant", m3: "user", m4: "assistant", m5: "user", m6: "assistant",
};
const ids = ["m1", "m2", "m3", "m4", "m5", "m6"];
const roleOf = (id: string) => roles[id];
const anchors = ["m1", "m3", "m5"];

await runCase("userMessageIds returns only user messages, oldest first", () => {
  const out = userMessageIds(ids, roleOf);
  assert(out.length === 3 && out[0] === "m1" && out[2] === "m5", `got ${out}`);
});

await runCase("anchorFor resolves index + total", () => {
  const a = anchorFor(anchors, "m3");
  assert(a?.index === 2 && a.total === 3, "m3 is 2/3");
  assert(anchorFor(anchors, "m2") === null, "assistant msg not an anchor");
  assert(anchorFor(anchors, null) === null, "null → null");
});

await runCase("previous from nothing jumps to latest", () => {
  const t = resolveUserMessageNavTarget(anchors, null, "previous");
  assert(t?.id === "m5" && t.index === 3, "latest user msg");
});

await runCase("previous walks back one user message at a time", () => {
  let cur = resolveUserMessageNavTarget(anchors, "m5", "previous");
  assert(cur?.id === "m3" && cur.index === 2, "m5 → m3");
  cur = resolveUserMessageNavTarget(anchors, cur?.id, "previous");
  assert(cur?.id === "m1" && cur.index === 1, "m3 → m1");
  // At the first user message: stays (no wrap).
  cur = resolveUserMessageNavTarget(anchors, cur?.id, "previous");
  assert(cur?.id === "m1", "stays at first");
});

await runCase("next walks forward and stops at latest", () => {
  let cur = resolveUserMessageNavTarget(anchors, "m1", "next");
  assert(cur?.id === "m3", "m1 → m3");
  cur = resolveUserMessageNavTarget(anchors, cur?.id, "next");
  assert(cur?.id === "m5", "m3 → m5");
  cur = resolveUserMessageNavTarget(anchors, cur?.id, "next");
  assert(cur === null, "at latest → null");
});

await runCase("next from nothing returns null (use latest instead)", () => {
  assert(resolveUserMessageNavTarget(anchors, null, "next") === null, "next w/o cursor → null");
});

await runCase("latest always jumps to the most recent user message", () => {
  const t = resolveUserMessageNavTarget(anchors, "m1", "latest");
  assert(t?.id === "m5" && t.index === 3, "latest");
});

await runCase("no user messages → all nav returns null", () => {
  const empty: string[] = [];
  assert(resolveUserMessageNavTarget(empty, null, "previous") === null, "prev");
  assert(resolveUserMessageNavTarget(empty, null, "next") === null, "next");
  assert(resolveUserMessageNavTarget(empty, null, "latest") === null, "latest");
});

await runCase("single user message: prev/next/latest all resolve to it (or null)", () => {
  const one = ["m1"];
  assert(resolveUserMessageNavTarget(one, "m1", "previous")?.id === "m1", "prev stays");
  assert(resolveUserMessageNavTarget(one, "m1", "next") === null, "next null at latest");
  assert(resolveUserMessageNavTarget(one, "m1", "latest")?.id === "m1", "latest = itself");
});

console.log("userMessageNav: all cases passed");
