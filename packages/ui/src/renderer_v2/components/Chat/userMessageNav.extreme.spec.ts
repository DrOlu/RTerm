import {
  anchorFor,
  resolveUserMessageNavTarget,
  userMessageIds,
} from "./userMessageNav";

/**
 * userMessageNav.extreme.spec — user-message navigation model.
 * Run: npx tsx --test packages/ui/src/renderer_v2/components/Chat/userMessageNav.extreme.spec.ts
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

await runCase("anchorFor resolves id → 1-based index + total", () => {
  const a = anchorFor(anchors, "u2");
  assert(a?.index === 2 && a.total === 3 && a.id === "u2", `anchor=${JSON.stringify(a)}`);
  assert(anchorFor(anchors, "a1") === null, "assistant message is not an anchor");
  assert(anchorFor(anchors, null) === null, "null → null");
});

await runCase("previous from nothing → latest user message", () => {
  const t = resolveUserMessageNavTarget(anchors, null, "previous");
  assert(t?.id === "u3" && t.index === 3, `target=${JSON.stringify(t)}`);
});

await runCase("previous walks up, clamps at first (no wrap)", () => {
  const t1 = resolveUserMessageNavTarget(anchors, "u3", "previous");
  assert(t1?.id === "u2", `t1=${t1?.id}`);
  const t2 = resolveUserMessageNavTarget(anchors, "u2", "previous");
  assert(t2?.id === "u1", `t2=${t2?.id}`);
  const t3 = resolveUserMessageNavTarget(anchors, "u1", "previous");
  assert(t3?.id === "u1", `clamp at first, got ${t3?.id}`);
});

await runCase("next walks down, null at latest", () => {
  const t1 = resolveUserMessageNavTarget(anchors, "u1", "next");
  assert(t1?.id === "u2", `t1=${t1?.id}`);
  const t2 = resolveUserMessageNavTarget(anchors, "u3", "next");
  assert(t2 === null, "next at latest → null");
  const t3 = resolveUserMessageNavTarget(anchors, null, "next");
  assert(t3 === null, "next from nothing → null");
});

await runCase("latest always jumps to most recent user message", () => {
  const t = resolveUserMessageNavTarget(anchors, "u1", "latest");
  assert(t?.id === "u3" && t.index === 3, `latest=${t?.id}`);
});

await runCase("empty anchors → all targets null", () => {
  for (const dir of ["previous", "next", "latest"] as const) {
    assert(resolveUserMessageNavTarget([], null, dir) === null, `${dir} on empty`);
  }
});

console.log("userMessageNav: all cases passed");
