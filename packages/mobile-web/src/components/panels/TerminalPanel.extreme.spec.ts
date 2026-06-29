import {
  shouldMarkActiveTerminalBufferSeen,
} from "./TerminalPanel";
import type { TerminalBufferEntry } from "../../hooks/useTerminalBuffer";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const runCase = (name: string, fn: () => void): void => {
  fn();
  console.log(`PASS ${name}`);
};

function makeBuffer(
  terminalId: string,
  hasNew: boolean,
): TerminalBufferEntry {
  return {
    terminalId,
    text: "output",
    offset: 42,
    updatedAt: 1,
    hasNew,
  };
}

runCase("shouldMarkActiveTerminalBufferSeen: ignores missing active tab", () => {
  assertEqual(
    shouldMarkActiveTerminalBufferSeen(null, makeBuffer("t1", true)),
    false,
    "no active terminal should not mark seen",
  );
});

runCase("shouldMarkActiveTerminalBufferSeen: ignores missing buffer", () => {
  assertEqual(
    shouldMarkActiveTerminalBufferSeen("t1", undefined),
    false,
    "missing buffer should not mark seen",
  );
});

runCase("shouldMarkActiveTerminalBufferSeen: ignores inactive terminal output", () => {
  assertEqual(
    shouldMarkActiveTerminalBufferSeen("t1", makeBuffer("t2", true)),
    false,
    "inactive terminal output should keep unread marker",
  );
});

runCase("shouldMarkActiveTerminalBufferSeen: ignores already seen active buffer", () => {
  assertEqual(
    shouldMarkActiveTerminalBufferSeen("t1", makeBuffer("t1", false)),
    false,
    "already seen active output should not update",
  );
});

runCase("shouldMarkActiveTerminalBufferSeen: clears new output on visible active terminal", () => {
  assertEqual(
    shouldMarkActiveTerminalBufferSeen("t1", makeBuffer("t1", true)),
    true,
    "visible active output should be marked seen",
  );
});

console.log("\nAll TerminalPanel extreme tests passed.");
