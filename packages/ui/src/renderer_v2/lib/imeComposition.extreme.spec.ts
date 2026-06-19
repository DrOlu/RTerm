import {
  createImeCompositionTracker,
  disposeImeCompositionTracker,
  isNativeImeKeyEvent,
  markImeCompositionEnd,
  markImeCompositionStart,
  shouldLetImeHandleKeyDown,
  shouldSuppressPostCompositionEnter,
} from "./imeComposition";

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

runCase("IME Enter is left to the composition engine", () => {
  const tracker = createImeCompositionTracker();
  markImeCompositionStart(tracker);

  assertEqual(
    shouldLetImeHandleKeyDown(tracker, {
      key: "Enter",
      nativeEvent: { isComposing: true },
    }),
    true,
    "composing Enter must not be handled by the app",
  );
  assertEqual(
    shouldSuppressPostCompositionEnter(tracker, { key: "Enter" }),
    false,
    "active composition Enter should not be preventDefaulted before the IME commits",
  );

  disposeImeCompositionTracker(tracker);
});

runCase("keyCode 229 is treated as an IME key event", () => {
  assertEqual(
    isNativeImeKeyEvent({ key: "Enter", nativeEvent: { keyCode: 229 } }),
    true,
    "Electron/Chromium keyCode 229 should identify IME composition keys",
  );
});

runCase("first Enter after composition end is suppressed once", () => {
  const tracker = createImeCompositionTracker();
  markImeCompositionStart(tracker);
  markImeCompositionEnd(tracker);

  assertEqual(
    shouldSuppressPostCompositionEnter(tracker, { key: "Enter" }),
    true,
    "the trailing Enter after IME commit should not send the prompt",
  );
  assertEqual(
    shouldSuppressPostCompositionEnter(tracker, { key: "Enter" }),
    false,
    "a separate subsequent Enter should be available to the app",
  );

  disposeImeCompositionTracker(tracker);
});

console.log("All IME composition extreme tests passed.");
