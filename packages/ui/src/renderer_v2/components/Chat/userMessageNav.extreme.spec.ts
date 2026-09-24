import {
  anchorFor,
  nextUserNavCorrectionBudget,
  resolveUserMessageNavTarget,
  USER_NAV_CORRECTION_BUDGET,
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

// ---------------------------- v3.9.4 correction-budget state machine
await runCase("v3.9.4: a new click always resets the correction budget", () => {
  const b = nextUserNavCorrectionBudget({
    isNewClick: true,
    budget: 0,
    nextScrollTop: 1234,
    lastAppliedScrollTop: 1234,
  });
  assert(b === USER_NAV_CORRECTION_BUDGET, `new click budget=${b}`);
});

await runCase("v3.9.4: converged layout (same scrollTop twice) stops correcting", () => {
  const b = nextUserNavCorrectionBudget({
    isNewClick: false,
    budget: 3,
    nextScrollTop: 1000,
    lastAppliedScrollTop: 1000,
  });
  assert(b === 0, `converged must stop, got ${b}`);
  // and from the converged state with budget 0, stays 0
  const b2 = nextUserNavCorrectionBudget({
    isNewClick: false,
    budget: 0,
    nextScrollTop: 1000,
    lastAppliedScrollTop: 999.5,
  });
  assert(b2 === 0, `exhausted budget stays 0`);
});

await runCase("v3.9.4: unsettled layout decrements the budget, never exceeds the cap", () => {
  // first correction pass: measurement shifted the target (estimated->measured)
  const b = nextUserNavCorrectionBudget({
    isNewClick: false,
    budget: 6,
    nextScrollTop: 1100,
    lastAppliedScrollTop: 1000,
  });
  assert(b === 5, `drifting layout decrements, got ${b}`);
  // the budget drains to zero even if the layout never converges — the
  // v3.2.10 scroll-trap can NEVER come back from this path
  let budget = 6;
  for (let i = 0; i < 10; i++) {
    budget = nextUserNavCorrectionBudget({
      isNewClick: false,
      budget,
      nextScrollTop: 1000 + i, // always drifting
      lastAppliedScrollTop: 1000 + i - 1,
    });
  }
  assert(budget === 0, `perpetually-drifting layout must drain to 0, got ${budget}`);
});

await runCase("v3.9.4: first correction with no prior applied scrollTop proceeds (null)", () => {
  const b = nextUserNavCorrectionBudget({
    isNewClick: false,
    budget: 6,
    nextScrollTop: 500,
    lastAppliedScrollTop: null,
  });
  assert(b === 5, `null last-applied must not count as converged, got ${b}`);
});

console.log("userMessageNav: all cases passed");
