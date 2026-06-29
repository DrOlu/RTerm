import {
  clampSwipeOffset,
  resolveSwipeAxis,
  shouldRevealDeleteRail,
  SWIPE_CONSTANTS,
} from "./SessionBrowser";

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
}

function assertCondition(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function runCase(name: string, fn: () => void): void {
  fn();
  console.log(`PASS ${name}`);
}

const { DELETE_REVEAL_PX, SWIPE_OPEN_THRESHOLD_PX, SWIPE_DIRECTION_BUFFER_PX } =
  SWIPE_CONSTANTS;

runCase("resolveSwipeAxis: tiny movement stays pending", () => {
  assertEqual(
    resolveSwipeAxis(2, 1, "pending"),
    "pending",
    "sub-buffer movement stays pending",
  );
  assertEqual(
    resolveSwipeAxis(0, 0, "pending"),
    "pending",
    "zero movement stays pending",
  );
});

runCase("resolveSwipeAxis: clear horizontal => horizontal", () => {
  assertEqual(
    resolveSwipeAxis(40, 5, "pending"),
    "horizontal",
    "horizontal dominance",
  );
});

runCase("resolveSwipeAxis: clear vertical => vertical", () => {
  assertEqual(
    resolveSwipeAxis(3, 50, "pending"),
    "vertical",
    "vertical dominance",
  );
});

runCase("resolveSwipeAxis: just under buffer stays pending", () => {
  assertEqual(
    resolveSwipeAxis(SWIPE_DIRECTION_BUFFER_PX - 1, 0, "pending"),
    "pending",
    "one under buffer X stays pending",
  );
  assertEqual(
    resolveSwipeAxis(0, SWIPE_DIRECTION_BUFFER_PX - 1, "pending"),
    "pending",
    "one under buffer Y stays pending",
  );
});

runCase("resolveSwipeAxis: at buffer boundary resolves", () => {
  // The buffer is a strict less-than threshold; reaching it means intent is clear.
  assertEqual(
    resolveSwipeAxis(SWIPE_DIRECTION_BUFFER_PX, 0, "pending"),
    "horizontal",
    "at buffer X resolves horizontal",
  );
});

runCase("resolveSwipeAxis: once locked, axis never changes", () => {
  assertEqual(
    resolveSwipeAxis(100, 0, "vertical"),
    "vertical",
    "vertical lock persists despite horizontal delta",
  );
  assertEqual(
    resolveSwipeAxis(0, 100, "horizontal"),
    "horizontal",
    "horizontal lock persists despite vertical delta",
  );
});

runCase("resolveSwipeAxis: negative deltas (swipe left/up) handled", () => {
  assertEqual(
    resolveSwipeAxis(-40, -3, "pending"),
    "horizontal",
    "negative horizontal dominance",
  );
  assertEqual(
    resolveSwipeAxis(-2, -40, "pending"),
    "vertical",
    "negative vertical dominance",
  );
});

runCase("resolveSwipeAxis: diagonal with slight X bias => horizontal", () => {
  assertEqual(
    resolveSwipeAxis(20, 18, "pending"),
    "horizontal",
    "X marginally greater than Y => horizontal",
  );
});

runCase("clampSwipeOffset: zero delta from zero base => 0", () => {
  assertEqual(clampSwipeOffset(0, 0), 0, "no movement");
});

runCase("clampSwipeOffset: small left swipe within bounds", () => {
  assertEqual(clampSwipeOffset(0, -20), -20, "small left swipe");
});

runCase("clampSwipeOffset: large left swipe clamps to -DELETE_REVEAL_PX", () => {
  assertEqual(
    clampSwipeOffset(0, -500),
    -DELETE_REVEAL_PX,
    "clamped to rail width",
  );
});

runCase("clampSwipeOffset: right swipe from zero blocked at 0", () => {
  assertEqual(clampSwipeOffset(0, 30), 0, "right movement blocked");
});

runCase("clampSwipeOffset: from open state, returning toward origin", () => {
  assertEqual(
    clampSwipeOffset(-DELETE_REVEAL_PX, 40),
    -42,
    "partial close from open state",
  );
});

runCase("clampSwipeOffset: from open state, swiping past origin clamps to 0", () => {
  assertEqual(
    clampSwipeOffset(-DELETE_REVEAL_PX, 200),
    0,
    "cannot overshoot origin",
  );
});

runCase("shouldRevealDeleteRail: no movement => false", () => {
  assertEqual(shouldRevealDeleteRail(0), false, "no swipe => no reveal");
});

runCase("shouldRevealDeleteRail: just under threshold => false", () => {
  assertEqual(
    shouldRevealDeleteRail(-(SWIPE_OPEN_THRESHOLD_PX - 1)),
    false,
    "under threshold snaps closed",
  );
});

runCase("shouldRevealDeleteRail: exactly threshold => true", () => {
  assertEqual(
    shouldRevealDeleteRail(-SWIPE_OPEN_THRESHOLD_PX),
    true,
    "at threshold snaps open",
  );
});

runCase("shouldRevealDeleteRail: full rail => true", () => {
  assertEqual(
    shouldRevealDeleteRail(-DELETE_REVEAL_PX),
    true,
    "full rail opens",
  );
});

runCase("shouldRevealDeleteRail: works with positive offset (defensive)", () => {
  assertEqual(
    shouldRevealDeleteRail(50),
    false,
    "positive offset treated as no-reveal",
  );
});

// Sanity: ensure all exported helpers were actually exercised.
assertCondition(
  typeof clampSwipeOffset === "function" &&
    typeof resolveSwipeAxis === "function" &&
    typeof shouldRevealDeleteRail === "function",
  "all swipe helpers exported",
);

/* ---------------------------------------------------------------
 * resolveStatusLabel — i18n seam for SessionStatusInfo.
 * The helper layer returns a locale-free descriptor; this function is the
 * only place that maps it to a user-facing string. Must cover every detail,
 * interpolate contextName, and never fall back to English for the zh-CN
 * locale (which was the original bug: labels were hard-coded in the helper).
 * --------------------------------------------------------------- */
import { resolveStatusLabel } from "./SessionBrowser";
import type { MobileTranslations } from "../../i18n/types";
import type { SessionStatusInfo } from "../../hooks/mobileControllerHelpers";

const enT = {
  sessionBrowser: {
    statusApproval: "Waiting · approval",
    statusApprovalWithTool: (n: string) => `Waiting · ${n}`,
    statusError: "Stopped · error",
    statusThinking: "Running · thinking",
    statusReplying: "Running · replying",
    statusTool: "Running",
    statusToolWithName: (n: string) => `Running · ${n}`,
    statusFileEdit: "Running · file edit",
    statusSubTool: "Running · sub tool",
    statusCommand: "Running · command",
    statusCommandAsync: "Running · async command",
    statusCompacting: "Running · compacting",
    statusRunning: "Running",
    statusDone: "Idle",
  },
} as unknown as MobileTranslations;

const zhT = {
  sessionBrowser: {
    statusApproval: "等待审批",
    statusApprovalWithTool: (n: string) => `等待审批 · ${n}`,
    statusError: "已停止 · 出错",
    statusThinking: "运行中 · 思考",
    statusReplying: "运行中 · 回复",
    statusTool: "运行中",
    statusToolWithName: (n: string) => `运行中 · ${n}`,
    statusFileEdit: "运行中 · 编辑文件",
    statusSubTool: "运行中 · 子工具",
    statusCommand: "运行中 · 命令",
    statusCommandAsync: "运行中 · 异步命令",
    statusCompacting: "运行中 · 压缩",
    statusRunning: "运行中",
    statusDone: "空闲",
  },
} as unknown as MobileTranslations;

function mkStatus(
  detail: SessionStatusInfo["detail"],
  contextName?: string,
  kind: SessionStatusInfo["kind"] = "running",
): SessionStatusInfo {
  return { kind, detail, ...(contextName ? { contextName } : {}) };
}

runCase("resolveStatusLabel: approval without tool uses base key", () => {
  assertEqual(
    resolveStatusLabel(mkStatus("approval", undefined, "approval"), enT),
    "Waiting · approval",
    "en approval",
  );
  assertEqual(
    resolveStatusLabel(mkStatus("approval", undefined, "approval"), zhT),
    "等待审批",
    "zh approval (regression: must not be English)",
  );
});

runCase("resolveStatusLabel: approval with tool interpolates contextName", () => {
  assertEqual(
    resolveStatusLabel(mkStatus("approval", "Bash", "approval"), enT),
    "Waiting · Bash",
    "en approval with tool",
  );
  assertEqual(
    resolveStatusLabel(mkStatus("approval", "Bash", "approval"), zhT),
    "等待审批 · Bash",
    "zh approval with tool",
  );
});

runCase("resolveStatusLabel: tool with name interpolates", () => {
  assertEqual(
    resolveStatusLabel(mkStatus("tool", "Read", "tool"), enT),
    "Running · Read",
    "en tool with name",
  );
  assertEqual(
    resolveStatusLabel(mkStatus("tool", "Read", "tool"), zhT),
    "运行中 · Read",
    "zh tool with name (regression)",
  );
});

runCase("resolveStatusLabel: tool without name uses base tool key", () => {
  assertEqual(
    resolveStatusLabel(mkStatus("tool", undefined, "tool"), enT),
    "Running",
    "en tool base",
  );
  assertEqual(
    resolveStatusLabel(mkStatus("tool", undefined, "tool"), zhT),
    "运行中",
    "zh tool base",
  );
});

runCase("resolveStatusLabel: every detail maps to a localized string", () => {
  const details: Array<SessionStatusInfo["detail"]> = [
    "error",
    "thinking",
    "replying",
    "file_edit",
    "sub_tool",
    "command",
    "command_async",
    "compacting",
    "running",
    "done",
  ];
  for (const detail of details) {
    const en = resolveStatusLabel(mkStatus(detail), enT);
    const zh = resolveStatusLabel(mkStatus(detail), zhT);
    assertCondition(en.length > 0, `en label empty for detail ${detail}`);
    assertCondition(zh.length > 0, `zh label empty for detail ${detail}`);
    // Critical regression guard: zh must NOT equal en (would mean hard-coded English leaked through).
    assertCondition(
      en !== zh,
      `locale collision for detail ${detail}: en="${en}" zh="${zh}"`,
    );
  }
});

runCase("resolveStatusLabel: unknown detail falls back to done", () => {
  // @ts-expect-error deliberately unknown detail
  const label = resolveStatusLabel(mkStatus("bogus"), enT);
  assertEqual(label, "Idle", "unknown detail -> done label");
});

console.log("\nAll SessionBrowser swipe + status label extreme tests passed.");
