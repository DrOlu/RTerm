import {
  PASS_CHAT_SUGGESTION_TITLE_LIMIT,
  MENTION_SUGGESTION_MAX_HEIGHT,
  MENTION_SUGGESTION_MENU_WIDTH,
  resolveMentionSuggestionMenuDimensions,
  truncatePassChatSuggestionTitle,
} from "./mentionSuggestionPresentation";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const assert = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const runCase = (name: string, fn: () => void): void => {
  fn();
  console.log(`PASS ${name}`);
};

runCase("pass-chat suggestion titles truncate at the menu display limit", () => {
  const title = "江原 展厅Driver升级和超长标题用于验证二层选择器不会被撑满整个窗口";
  const truncated = truncatePassChatSuggestionTitle(title);

  assertEqual(
    Array.from(truncated.replace(/\.\.\.$/, "")).length,
    PASS_CHAT_SUGGESTION_TITLE_LIMIT,
    "visible title should keep exactly the configured number of characters before ellipsis",
  );
  assert(truncated.endsWith("..."), "long titles should end with ellipsis");
  assert(
    truncated.length < title.length,
    "long titles should be shorter than the full title",
  );
});

runCase("pass-chat suggestion titles preserve short chat titles", () => {
  const title = "江原 展厅Driver升级";
  assertEqual(
    truncatePassChatSuggestionTitle(title),
    title,
    "short titles should remain unchanged",
  );
});

runCase("pass-chat picker reuses the base mention menu dimensions", () => {
  const passChatDimensions = resolveMentionSuggestionMenuDimensions(
    "pass-chat",
    1600,
  );
  const mentionDimensions = resolveMentionSuggestionMenuDimensions(
    "mention",
    1600,
  );

  assertEqual(
    passChatDimensions.width,
    mentionDimensions.width,
    "pass-chat picker should replace content inside the same menu width",
  );
  assertEqual(
    passChatDimensions.preferredMaxHeight,
    mentionDimensions.preferredMaxHeight,
    "pass-chat picker should replace content inside the same menu max height",
  );
});

runCase("suggestion menu dimensions clamp inside narrow viewports", () => {
  const dimensions = resolveMentionSuggestionMenuDimensions("pass-chat", 240);

  assertEqual(
    dimensions.width,
    224,
    "picker width should stay inside viewport margins",
  );
});

runCase("base mention menu keeps the compact default dimensions", () => {
  const dimensions = resolveMentionSuggestionMenuDimensions("mention", 1600);

  assertEqual(
    dimensions.width,
    MENTION_SUGGESTION_MENU_WIDTH,
    "base mention menu should keep its compact width",
  );
  assertEqual(
    dimensions.preferredMaxHeight,
    MENTION_SUGGESTION_MAX_HEIGHT,
    "base mention menu should keep its compact max height",
  );
});
