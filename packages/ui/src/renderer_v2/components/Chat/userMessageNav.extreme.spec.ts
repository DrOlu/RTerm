import {
  anchorFor,
  resolveUserMessageNavTarget,
  userMessageIds,
  userNavScrollTop,
} from "./userMessageNav";

/**
 * userMessageNav.extreme.spec — user-message navigation model.
 * Run: npx tsx packages/ui/src/renderer_v2/components/Chat/userMessageNav.extreme.spec.ts
 */

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`assert failed: ${msg}`);
};

const runCase = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

// anchors: u1, a1, u2, a2, u3 (roles)
const ids = ["u1", "a1", "u2", "a2", "u3"];
const roleOf = (id: string) => (id.startsWith("u") ? "user" : "assistant");
const anchors = userMessageIds(ids, roleOf);

await runCase("userMessageIds extracts only user messages in order", () => {
  assert(JSON.stringify(anchors) === JSON.stringify(["u1", "u2", "u3"]), `anchors=${anchors}`);
});

await runCase("userMessageIds ignores assistant / tool / empty roles", () => {
  const mixed = userMessageIds(
    ["sys", "u1", "tool", "a1", "u2", ""],
    (id) => (id.startsWith("u") ? "user" : id.startsWith("a") ? "assistant" : id === "tool" ? "tool" : undefined),
  );
  assert(JSON.stringify(mixed) === JSON.stringify(["u1", "u2"]), `mixed=${mixed}`);
});

await runCase("anchorFor resolves id → 1-based index + total", () => {
  const a = anchorFor(anchors, "u2");
  assert(a?.index === 2 && a.total === 3 && a.id === "u2", `anchor=${JSON.stringify(a)}`);
  assert(anchorFor(anchors, "a1") === null, "assistant message is not an anchor");
  assert(anchorFor(anchors, null) === null, "null → null");
  assert(anchorFor(anchors, "") === null, "empty → null");
});

await runCase("previous from nothing → latest user query (not assistant)", () => {
  const t = resolveUserMessageNavTarget(anchors, null, "previous");
  assert(t?.id === "u3" && t.index === 3, `target=${JSON.stringify(t)}`);
});

await runCase("previous walks up through USER queries only", () => {
  const t1 = resolveUserMessageNavTarget(anchors, "u3", "previous");
  assert(t1?.id === "u2", `t1=${t1?.id}`);
  const t2 = resolveUserMessageNavTarget(anchors, "u2", "previous");
  assert(t2?.id === "u1", `t2=${t2?.id}`);
});

await runCase("previous at first WRAPS to latest (buttons stay enabled)", () => {
  const t3 = resolveUserMessageNavTarget(anchors, "u1", "previous");
  assert(t3?.id === "u3", `wrap to latest, got ${t3?.id}`);
});

await runCase("next from nothing → FIRST user query (always-on Next)", () => {
  const t = resolveUserMessageNavTarget(anchors, null, "next");
  assert(t?.id === "u1" && t.index === 1, `from nothing next=${JSON.stringify(t)}`);
});

await runCase("next walks down through USER queries only", () => {
  const t1 = resolveUserMessageNavTarget(anchors, "u1", "next");
  assert(t1?.id === "u2", `t1=${t1?.id}`);
  const t2 = resolveUserMessageNavTarget(anchors, "u2", "next");
  assert(t2?.id === "u3", `t2=${t2?.id}`);
});

await runCase("next at latest WRAPS to first (buttons stay enabled)", () => {
  const t = resolveUserMessageNavTarget(anchors, "u3", "next");
  assert(t?.id === "u1", `wrap to first, got ${t?.id}`);
});

await runCase("latest always jumps to most recent user query", () => {
  const t = resolveUserMessageNavTarget(anchors, "u1", "latest");
  assert(t?.id === "u3" && t.index === 3, `latest=${t?.id}`);
  const t2 = resolveUserMessageNavTarget(anchors, null, "latest");
  assert(t2?.id === "u3", `latest from nothing=${t2?.id}`);
});

await runCase("single user query: prev/next/latest all land on it (never disabled)", () => {
  const one = ["only-user"];
  for (const dir of ["previous", "next", "latest"] as const) {
    const t = resolveUserMessageNavTarget(one, null, dir);
    assert(t?.id === "only-user", `${dir} on single → ${t?.id}`);
    const t2 = resolveUserMessageNavTarget(one, "only-user", dir);
    assert(t2?.id === "only-user", `${dir} from self → ${t2?.id}`);
  }
});

await runCase("stale currentId (deleted / other session) treated as nothing", () => {
  const prev = resolveUserMessageNavTarget(anchors, "gone", "previous");
  assert(prev?.id === "u3", `stale previous → latest, got ${prev?.id}`);
  const next = resolveUserMessageNavTarget(anchors, "gone", "next");
  assert(next?.id === "u1", `stale next → first, got ${next?.id}`);
});

await runCase("empty anchors → all targets null (no crash)", () => {
  for (const dir of ["previous", "next", "latest"] as const) {
    assert(resolveUserMessageNavTarget([], null, dir) === null, `${dir} on empty`);
    assert(resolveUserMessageNavTarget([], "u1", dir) === null, `${dir} on empty with id`);
  }
});

await runCase("userNavScrollTop pins the query to the TOP, never centers", () => {
  assert(userNavScrollTop(400, 8) === 392, `400-8=${userNavScrollTop(400, 8)}`);
  assert(userNavScrollTop(4, 8) === 0, "clamps at 0 (does not go negative)");
  assert(userNavScrollTop(0) === 0, "top of list stays 0");
  assert(userNavScrollTop(-20) === 0, "negative target clamps");
  assert(userNavScrollTop(Number.NaN) === 0, "NaN clamps");
  // Centering would have been targetTop - (viewport - height)/2. We never do that:
  const centeredWouldBe = 400 - Math.max(0, (800 - 40) / 2); // 20
  assert(userNavScrollTop(400, 8) !== centeredWouldBe, "must not equal the old center formula");
});

await runCase("wrap cycle visits every user query then returns (never assistant)", () => {
  const seen: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < 6; i++) {
    const t = resolveUserMessageNavTarget(anchors, cur, "next");
    assert(t && t.id.startsWith("u"), `next landed on assistant? ${t?.id}`);
    seen.push(t!.id);
    cur = t!.id;
  }
  assert(JSON.stringify(seen) === JSON.stringify(["u1", "u2", "u3", "u1", "u2", "u3"]), `cycle=${seen}`);
});

console.log("userMessageNav: all cases passed");
