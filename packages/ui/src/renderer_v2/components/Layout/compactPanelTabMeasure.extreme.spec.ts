import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCompactPanelTabMeasureSignature,
  resolveCompactPanelTabMenuScrollbarCompensation,
} from "./compactPanelTabMeasure";

const currentDir = dirname(fileURLToPath(import.meta.url));
const compactTabStylesheet = readFileSync(
  join(currentDir, "compactPanelTabSelect.scss"),
  "utf8",
);
const compactTabComponent = readFileSync(
  join(currentDir, "CompactPanelTabSelect.tsx"),
  "utf8",
);

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
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

const assertNotEqual = <T>(left: T, right: T, message: string): void => {
  if (left === right) {
    throw new Error(`${message}. both=${String(left)}`);
  }
};

const runCase = (name: string, fn: () => void): void => {
  fn();
  console.log(`PASS ${name}`);
};

runCase(
  "equivalent compact tab layouts keep the same measure signature across rerenders",
  () => {
    const first = buildCompactPanelTabMeasureSignature({
      panelKind: "chat",
      resolvedValue: "chat-a",
      activeLabel: "@mac help me",
      activeMeasureKey: "@mac help me",
      activeLeadingMeasureKey: "no-leading",
      activeTrailingMeasureKey: "no-trailing",
      hasActiveLeading: false,
      hasActiveTrailing: false,
      hasTrailingActionRail: true,
      entries: [
        {
          value: "chat-a",
          label: "@mac help me",
          hasLeading: false,
          hasTrailing: false,
          hasClose: true,
        },
        {
          value: "chat-b",
          label: "@win inspect this",
          hasLeading: false,
          hasTrailing: false,
          hasClose: true,
        },
      ],
    });

    const second = buildCompactPanelTabMeasureSignature({
      panelKind: "chat",
      resolvedValue: "chat-a",
      activeLabel: "@mac help me",
      activeMeasureKey: "@mac help me",
      activeLeadingMeasureKey: "no-leading",
      activeTrailingMeasureKey: "no-trailing",
      hasActiveLeading: false,
      hasActiveTrailing: false,
      hasTrailingActionRail: true,
      entries: [
        {
          value: "chat-a",
          label: "@mac help me",
          hasLeading: false,
          hasTrailing: false,
          hasClose: true,
        },
        {
          value: "chat-b",
          label: "@win inspect this",
          hasLeading: false,
          hasTrailing: false,
          hasClose: true,
        },
      ],
    });

    assertEqual(
      first,
      second,
      "layout-equivalent compact tabs should not force a new measure signature on rerender",
    );
  },
);

runCase(
  "portaled compact tab menus keep the panel-kind spacing variables",
  () => {
    assertMatch(
      compactTabComponent,
      /className="gyshell-compact-tab-menu"[\s\S]*data-layout-tab-kind=\{panelKind\}/,
      "portaled compact tab menus should carry panelKind for kind-specific CSS variables",
    );

    assertMatch(
      compactTabStylesheet,
      /\.gyshell-compact-tab-select,\s*\.gyshell-compact-tab-menu\s*\{[\s\S]*--compact-tab-inline-padding:/,
      "base compact tab variables should be available on both the trigger and portaled menu",
    );

    ["terminal", "chat", "filesystem", "monitor"].forEach((kind) => {
      assertMatch(
        compactTabStylesheet,
        new RegExp(
          `\\.gyshell-compact-tab-menu\\[data-layout-tab-kind="${kind}"\\]`,
        ),
        `${kind} compact tab menu should receive the same kind-specific CSS variables as its trigger`,
      );
    });
  },
);

runCase(
  "width-relevant compact tab changes produce a new measure signature",
  () => {
    const local = buildCompactPanelTabMeasureSignature({
      panelKind: "terminal",
      resolvedValue: "term-a",
      activeLabel: "LOCAL",
      activeMeasureKey: "LOCAL",
      activeLeadingMeasureKey: "local",
      activeTrailingMeasureKey: "ready",
      hasActiveLeading: true,
      hasActiveTrailing: true,
      hasTrailingActionRail: true,
      entries: [
        {
          value: "term-a",
          label: "LOCAL",
          leadingMeasureKey: "local",
          trailingMeasureKey: "ready",
          hasLeading: true,
          hasTrailing: true,
          hasClose: true,
        },
      ],
    });

    const remote = buildCompactPanelTabMeasureSignature({
      panelKind: "terminal",
      resolvedValue: "term-a",
      activeLabel: "LOCAL",
      activeMeasureKey: "LOCAL",
      activeLeadingMeasureKey: "remote",
      activeTrailingMeasureKey: "ready",
      hasActiveLeading: true,
      hasActiveTrailing: true,
      hasTrailingActionRail: true,
      entries: [
        {
          value: "term-a",
          label: "LOCAL",
          leadingMeasureKey: "remote",
          trailingMeasureKey: "ready",
          hasLeading: true,
          hasTrailing: true,
          hasClose: true,
        },
      ],
    });

    assertNotEqual(
      local,
      remote,
      "icon-kind changes should invalidate compact width measurements when callers provide measure keys",
    );
  },
);

runCase(
  "scrollable compact tab menus compensate for the scrollbar gutter externally",
  () => {
    const compensation = resolveCompactPanelTabMenuScrollbarCompensation({
      clientWidth: 232,
      offsetWidth: 249,
      clientHeight: 180,
      scrollHeight: 264,
      borderLeftWidth: 1,
      borderRightWidth: 1,
    });

    assertEqual(
      compensation,
      15,
      "vertical scrollbar width should be added outside the measured tab content width",
    );
  },
);

runCase(
  "compact tab menus add no extra width when they do not overflow vertically",
  () => {
    const compensation = resolveCompactPanelTabMenuScrollbarCompensation({
      clientWidth: 232,
      offsetWidth: 249,
      clientHeight: 264,
      scrollHeight: 264,
      borderLeftWidth: 1,
      borderRightWidth: 1,
    });

    assertEqual(
      compensation,
      0,
      "menus without vertical overflow should keep the same width as the trigger shell",
    );
  },
);
