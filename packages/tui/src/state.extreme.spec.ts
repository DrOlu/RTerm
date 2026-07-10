import {
  applyUiUpdate,
  compactMessageSummary,
  createSessionState,
} from "./state";
import type { ChatMessage } from "./protocol";

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

const makeTextMessage = (content: string): ChatMessage => ({
  id: "m1",
  role: "user",
  type: "text",
  content,
  timestamp: 1,
});

const makeStoredMessage = (
  id: string,
  backendMessageId: string,
  content: string,
): ChatMessage => ({
  id,
  role: "assistant",
  type: "text",
  content,
  timestamp: 1,
  backendMessageId,
});

runCase(
  "legacy paste label is not collapsed to preview text in TUI compact summaries",
  () => {
    const token = "[MENTION_USER_PASTE:#/tmp/paste.txt##preview#]";
    const summary = compactMessageSummary(makeTextMessage(token), true);

    assertCondition(
      summary.includes("MENTION USER PASTE"),
      "TUI summary should keep the legacy paste marker text",
    );
    assertCondition(
      summary.includes("/tmp/paste.txt"),
      "TUI summary should keep the legacy paste path",
    );
    assertCondition(
      summary !== "preview",
      "TUI summary should not collapse to the old preview text",
    );
  },
);

runCase(
  "TUI supported mention compact summaries still use display names",
  () => {
    assertEqual(
      compactMessageSummary(
        makeTextMessage("[MENTION_TAB:#main##tab-1#]"),
        true,
      ),
      "@main",
      "tab mention should normalize",
    );
    assertEqual(
      compactMessageSummary(makeTextMessage("[MENTION_SKILL:#skill#]"), true),
      "@skill",
      "skill mention should normalize",
    );
    assertEqual(
      compactMessageSummary(
        makeTextMessage("[MENTION_FILE:#/tmp/report.md#]"),
        true,
      ),
      "report.md",
      "file mention should normalize",
    );
    assertEqual(
      compactMessageSummary(
        makeTextMessage("[MENTION_PASS_CHAT:#s1##Previous%20Chat#]"),
        true,
      ),
      "@Pass Chat: Previous Chat",
      "pass-chat mention should normalize",
    );
  },
);

runCase(
  "TUI INSERT_MESSAGE keeps compaction boundary markers anchored after previous messages",
  () => {
    const session = createSessionState("s1");
    const previous = makeStoredMessage(
      "assistant-1",
      "backend-assistant-1",
      "done",
    );
    const next = makeStoredMessage("assistant-2", "backend-assistant-2", "next");
    const boundary: ChatMessage = {
      id: "boundary-1",
      role: "system",
      type: "compaction_boundary",
      content: "stale content should be cleared",
      timestamp: 2,
      backendMessageId: "backend-boundary-1",
      streaming: true,
      metadata: {
        compactionBoundaryPreviousBackendMessageId: previous.backendMessageId,
        compactionBoundarySummaryBackendMessageId: "backend-summary-1",
      },
    };
    session.messages.push(previous, next);

    applyUiUpdate(session, {
      type: "INSERT_MESSAGE",
      sessionId: session.id,
      message: boundary,
      anchorBackendMessageId: previous.backendMessageId,
      placement: "after",
    });

    assertEqual(
      session.messages.map((message) => message.id).join(","),
      "assistant-1,boundary-1,assistant-2",
      "previous-anchor boundary should remain after its previous message",
    );
    assertEqual(
      compactMessageSummary(session.messages[1], true),
      "[CTX COMPACTED]",
      "TUI boundary summary should remain visible after normalization",
    );
    assertEqual(
      session.messages[1]?.streaming,
      false,
      "stored boundary marker must not stay streaming",
    );
  },
);
