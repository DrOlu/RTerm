import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const stylesheet = readFileSync(join(currentDir, "chatHistory.scss"), "utf8");
const component = readFileSync(join(currentDir, "ChatHistoryPanel.tsx"), "utf8");

const selector = ".chat-history-item-title";
const selectorStart = stylesheet.indexOf(`${selector} {`);
assert.notEqual(selectorStart, -1, `${selector} rule should exist`);

const ruleEnd = stylesheet.indexOf("\n}", selectorStart);
assert.notEqual(ruleEnd, -1, `${selector} rule should be closed`);

const rule = stylesheet.slice(selectorStart, ruleEnd);

assert.match(
  rule,
  /display:\s*-webkit-box;/,
  "session titles should use a multi-line clamp container",
);
assert.match(
  rule,
  /-webkit-box-orient:\s*vertical;/,
  "session titles should clamp vertically",
);
assert.match(
  rule,
  /-webkit-line-clamp:\s*2;/,
  "session titles should truncate after two lines",
);
assert.match(
  rule,
  /line-height:\s*16px;/,
  "session titles should use a stable line height",
);
assert.match(
  rule,
  /height:\s*32px;/,
  "session history items should reserve two title lines",
);
assert.match(
  rule,
  /white-space:\s*normal;/,
  "session titles should be allowed to wrap",
);
assert.doesNotMatch(
  rule,
  /white-space:\s*nowrap;/,
  "session titles must not be forced to one line",
);
assert.doesNotMatch(
  rule,
  /text-overflow:\s*ellipsis;/,
  "single-line ellipsis should not be used for session titles",
);

assert.match(
  component,
  /\{normalizeSessionTitleText\(session\.title\)\}/,
  "history session titles should pass full normalized text to CSS clamping",
);
assert.doesNotMatch(
  component,
  /formatChatHistorySessionTitle/,
  "history session titles must not be pre-truncated before two-line layout",
);

console.log("chatHistoryPresentation.extreme.spec.ts passed");
