import { __test__ } from "./useTerminalBuffer";

const { trimTail, countTrailingNewlines, TAIL_MAX_CHARS } = __test__;

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const runCase = (name: string, fn: () => void): void => {
  fn();
  console.log(`PASS ${name}`);
};

/* ---------------------------------------------------------------
 * trimTail — keeps the rolling output window bounded so mobile
 * memory never blows up from a runaway command. Must always:
 * - never exceed TAIL_MAX_CHARS
 * - never return a partial line (always start at a newline boundary)
 * - return empty string unchanged
 * --------------------------------------------------------------- */

runCase("trimTail: empty string stays empty", () => {
  assertEqual(trimTail(""), "", "empty preserved");
});

runCase("trimTail: short string unchanged", () => {
  assertEqual(trimTail("hello\nworld"), "hello\nworld", "short preserved");
});

runCase("trimTail: long string trimmed to <= TAIL_MAX_CHARS", () => {
  const big = "x".repeat(TAIL_MAX_CHARS * 3);
  const trimmed = trimTail(big);
  assertCondition(
    trimmed.length <= TAIL_MAX_CHARS,
    `trimmed length ${trimmed.length} must be <= ${TAIL_MAX_CHARS}`,
  );
  assertCondition(
    trimmed.length > 0,
    "trimmed must retain content, not be empty",
  );
});

runCase("trimTail: trimmed result starts after a newline boundary", () => {
  // Build a string with newlines every 10 chars; ensure trim drops the partial first line
  const lines: string[] = [];
  for (let i = 0; i < (TAIL_MAX_CHARS / 10) + 50; i += 1) {
    lines.push(`line${i}___`); // 10 chars each, no trailing newline (joined below)
  }
  const big = lines.join("\n");
  const trimmed = trimTail(big);
  assertCondition(
    trimmed.length <= TAIL_MAX_CHARS,
    `trimmed length ${trimmed.length} within bound`,
  );
  // First character should not be in the middle of a line: either empty or starts at line beginning
  assertCondition(
    !trimmed.startsWith("ine") && !trimmed.startsWith("ne"),
    `trimmed should not begin mid-token, starts with: ${trimmed.slice(0, 8)}`,
  );
});

runCase("trimTail: string exactly at limit unchanged", () => {
  const exact = "y".repeat(TAIL_MAX_CHARS);
  assertEqual(trimTail(exact), exact, "exactly at limit preserved");
});

runCase("trimTail: one over limit gets trimmed", () => {
  const oneOver = "y".repeat(TAIL_MAX_CHARS + 1);
  const trimmed = trimTail(oneOver);
  assertCondition(trimmed.length < oneOver.length, "must trim");
  assertCondition(
    trimmed.endsWith("y"),
    "should keep the tail (ends with y)",
  );
});

/* ---------------------------------------------------------------
 * countTrailingNewlines — used to detect "new output" when only
 * a newline was appended. Must handle empty / no-newline / mixed.
 * --------------------------------------------------------------- */

runCase("countTrailingNewlines: empty => 0", () => {
  assertEqual(countTrailingNewlines(""), 0, "empty");
});

runCase("countTrailingNewlines: no trailing newline => 0", () => {
  assertEqual(countTrailingNewlines("abc"), 0, "no trailing newline");
});

runCase("countTrailingNewlines: single trailing newline => 1", () => {
  assertEqual(countTrailingNewlines("abc\n"), 1, "single trailing");
});

runCase("countTrailingNewlines: multiple trailing newlines counted", () => {
  assertEqual(countTrailingNewlines("abc\n\n\n"), 3, "three trailing");
});

runCase("countTrailingNewlines: internal newlines ignored", () => {
  assertEqual(countTrailingNewlines("a\nb\nc"), 0, "internal only");
});

runCase("countTrailingNewlines: trailing newline after internal newlines", () => {
  assertEqual(countTrailingNewlines("a\nb\nc\n"), 1, "one trailing after internal");
});

console.log("\nAll useTerminalBuffer extreme tests passed.");
