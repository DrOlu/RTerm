import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveCompactMenuTabReorderHint,
  resolveHorizontalTabBarReorderHint,
} from "./tabDropTargets";

const currentDir = dirname(fileURLToPath(import.meta.url));
const layoutWorkspaceSource = readFileSync(
  join(currentDir, "LayoutWorkspace.tsx"),
  "utf8",
);

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

const assertMatch = (
  actual: string,
  pattern: RegExp,
  message: string,
): void => {
  if (!pattern.test(actual)) {
    throw new Error(message);
  }
};

runCase(
  "horizontal tab bar keeps using visible header tabs as reorder anchors",
  () => {
    const hint = resolveHorizontalTabBarReorderHint(
      { left: 20, top: 10, width: 180, height: 28 },
      [
        { tabId: "tab-a", rect: { left: 24, top: 10, width: 44, height: 28 } },
        { tabId: "tab-b", rect: { left: 72, top: 10, width: 44, height: 28 } },
        { tabId: "tab-c", rect: { left: 120, top: 10, width: 44, height: 28 } },
      ],
      "dragging-tab",
      96,
    );
    if (!hint) {
      throw new Error("expected a reorder hint for a populated tab bar");
    }
    assertEqual(
      hint.anchorTabId,
      "tab-c",
      "horizontal reorder should target the next visible tab",
    );
    assertEqual(
      hint.position,
      "before",
      "horizontal reorder should insert before the next visible tab",
    );
    assertEqual(
      hint.indicatorRect.width,
      2,
      "horizontal indicator should stay vertical",
    );
  },
);

runCase("compact menu rows preserve direct before anchors", () => {
  const hint = resolveCompactMenuTabReorderHint(
    { tabId: "tab-b", rect: { left: 30, top: 80, width: 160, height: 28 } },
    "dragging-tab",
    88,
  );
  if (!hint) {
    throw new Error("expected a reorder hint for a hovered compact menu row");
  }
  assertEqual(
    hint.anchorTabId,
    "tab-b",
    "compact menu should anchor on the hovered row",
  );
  assertEqual(
    hint.position,
    "before",
    "upper-half hover should insert before the row",
  );
  assertEqual(
    hint.indicatorRect.top,
    80,
    "before indicator should align to the row top edge",
  );
  assertEqual(
    hint.indicatorRect.width,
    144,
    "compact menu indicator should span the row width",
  );
});

runCase("compact menu rows preserve direct after anchors", () => {
  const hint = resolveCompactMenuTabReorderHint(
    { tabId: "tab-c", rect: { left: 30, top: 120, width: 160, height: 28 } },
    "dragging-tab",
    146,
  );
  if (!hint) {
    throw new Error("expected a reorder hint for a hovered compact menu row");
  }
  assertEqual(
    hint.anchorTabId,
    "tab-c",
    "compact menu should anchor on the hovered row",
  );
  assertEqual(
    hint.position,
    "after",
    "lower-half hover should insert after the row",
  );
  assertEqual(
    hint.indicatorRect.top,
    146,
    "after indicator should align to the row bottom edge",
  );
  assertEqual(
    hint.indicatorRect.height,
    2,
    "compact menu indicator should be horizontal",
  );
});

runCase("compact menu ignores the dragged row itself", () => {
  const hint = resolveCompactMenuTabReorderHint(
    { tabId: "tab-b", rect: { left: 30, top: 80, width: 160, height: 28 } },
    "tab-b",
    92,
  );
  assertEqual(
    hint,
    null,
    "dragging over the same compact menu row should not create a reorder target",
  );
});

runCase(
  "portaled compact tab menu drag events are bridged back to workspace handlers",
  () => {
    assertMatch(
      layoutWorkspaceSource,
      /isPortaledCompactTabMenuTarget[\s\S]*\.gyshell-compact-tab-menu/,
      "LayoutWorkspace should recognize portaled compact tab menu targets",
    );
    [
      ["dragstart", "handleWindowDragStart"],
      ["dragenter", "handleWindowDragEnter"],
      ["dragover", "handleWindowDragOver"],
      ["drop", "handleWindowDrop"],
      ["dragend", "handleWindowDragEnd"],
    ].forEach(([eventName, handlerName]) => {
      assertMatch(
        layoutWorkspaceSource,
        new RegExp(
          `window\\.addEventListener\\("${eventName}",\\s*${handlerName},\\s*true\\)`,
        ),
        `window ${eventName} should bridge portaled compact menu dragging into LayoutWorkspace`,
      );
    });
  },
);
