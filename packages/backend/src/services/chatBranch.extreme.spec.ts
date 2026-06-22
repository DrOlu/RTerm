import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AIMessage,
  HumanMessage,
  mapChatMessagesToStoredMessages,
} from "@langchain/core/messages";
import { AgentService_v2 } from "./AgentService_v2";
import { ChatHistoryService } from "./ChatHistoryService";
import { UIHistoryService } from "./UIHistoryService";
import { HistorySqliteStore } from "./history/HistorySqliteStore";
import type { ChatSession } from "../types";

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

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

const createMessageId = (id: string): Record<string, unknown> => ({
  _gyshellMessageId: id,
});

const createAgent = (
  uiHistory: UIHistoryService,
  chatHistory: ChatHistoryService,
): AgentService_v2 =>
  new AgentService_v2(
    {} as any,
    {} as any,
    { getActiveTools: () => [] } as any,
    { getEnabledSkills: async () => [] } as any,
    { getMemorySnapshot: async () => ({ enabled: false, content: "" }) } as any,
    uiHistory,
    chatHistory,
  );

const saveSourceSession = (
  chatHistory: ChatHistoryService,
  uiHistory: UIHistoryService,
): void => {
  const source: ChatSession = {
    id: "source-session",
    title: "New Session",
    lastCheckpointOffset: 0,
    lastProfileMaxTokens: 64000,
    messages: new Map(),
  };
  const messages = mapChatMessagesToStoredMessages([
    new HumanMessage({
      content: "first user",
      additional_kwargs: createMessageId("backend-user-1"),
    }),
    new AIMessage({
      content: "first assistant",
      additional_kwargs: createMessageId("backend-assistant-1"),
    }),
    new HumanMessage({
      content: "second user",
      additional_kwargs: createMessageId("backend-user-2"),
    }),
    new AIMessage({
      content: "second assistant",
      additional_kwargs: createMessageId("backend-assistant-2"),
    }),
  ]) as any[];
  [
    "backend-user-1",
    "backend-assistant-1",
    "backend-user-2",
    "backend-assistant-2",
  ].forEach((id, index) => {
    source.messages.set(id, messages[index] as any);
  });
  chatHistory.saveSession(source);

  uiHistory.recordEvent("source-session", {
    type: "user_input",
    content: "first user",
    messageId: "backend-user-1",
  } as any);
  uiHistory.recordEvent("source-session", {
    type: "say",
    content: "first assistant",
    messageId: "backend-assistant-1",
  } as any);
  uiHistory.recordEvent("source-session", { type: "done" } as any);
  uiHistory.recordEvent("source-session", {
    type: "user_input",
    content: "second user",
    messageId: "backend-user-2",
  } as any);
  uiHistory.recordEvent("source-session", {
    type: "say",
    content: "second assistant",
    messageId: "backend-assistant-2",
  } as any);
  uiHistory.recordEvent("source-session", { type: "done" } as any);
  uiHistory.flush("source-session");
  uiHistory.renameSession("source-session", "Investigate outage");
};

const run = async (): Promise<void> => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gyshell-branch-extreme-"),
  );
  const sqlitePath = path.join(tempDir, "history.sqlite3");
  const store = new HistorySqliteStore({ filePath: sqlitePath });
  const chatHistory = new ChatHistoryService({ store });
  const uiHistory = new UIHistoryService({ store });
  const agent = createAgent(uiHistory, chatHistory);

  try {
    await runCase(
      "branch copies history through the selected assistant message",
      () => {
        saveSourceSession(chatHistory, uiHistory);
        const sourceUiBefore = uiHistory.getMessages("source-session");
        const result = agent.branchFromMessage(
          "source-session",
          "backend-assistant-2",
          "branch-session",
        );

        assertEqual(result.ok, true, "branch should succeed");
        assertEqual(
          result.sessionId,
          "branch-session",
          "branch should use the requested session id",
        );
        assertEqual(
          result.title,
          "Investigate outage_branch",
          "branch title should append _branch to the source session title",
        );

        const sourceStored = chatHistory.loadSession("source-session");
        const branchStored = chatHistory.loadSession("branch-session");
        assertEqual(
          sourceStored?.title,
          "New Session",
          "source agent history title intentionally stays stale in this regression case",
        );
        assertEqual(
          uiHistory.getSession("source-session")?.title,
          "Investigate outage",
          "source UI title should be the user-visible branch title source",
        );
        assertEqual(
          sourceStored?.messages.size,
          4,
          "source agent history must stay unchanged",
        );
        assertEqual(
          branchStored?.messages.size,
          4,
          "branch agent history should include the selected assistant",
        );
        assertCondition(
          branchStored?.messages.has("backend-assistant-2"),
          "selected assistant message must be included in branch agent history",
        );
        assertEqual(
          branchStored?.title,
          "Investigate outage_branch",
          "stored branch title should append _branch",
        );

        const sourceUiAfter = uiHistory.getMessages("source-session");
        const branchUi = uiHistory.getMessages("branch-session");
        assertEqual(
          sourceUiAfter.length,
          sourceUiBefore.length,
          "source UI history must stay unchanged",
        );
        assertEqual(
          branchUi.length,
          4,
          "branch UI history should include the selected assistant",
        );
        assertEqual(
          branchUi.some(
            (message) => message.backendMessageId === "backend-assistant-2",
          ),
          true,
          "selected assistant message must be included in branch UI history",
        );
        assertCondition(
          branchUi[0]?.id !== sourceUiBefore[0]?.id,
          "branch UI messages need fresh UI ids because ui_message_id is globally unique",
        );
        assertEqual(
          branchUi[0]?.backendMessageId,
          sourceUiBefore[0]?.backendMessageId,
          "branch UI messages should preserve backend message ids",
        );
      },
    );

    await runCase(
      "branch through the first user message creates a one-message session",
      () => {
        const result = agent.branchFromMessage(
          "source-session",
          "backend-user-1",
          "empty-branch-session",
        );
        assertEqual(result.ok, true, "branch from first user should succeed");
        assertEqual(
          chatHistory.loadSession("empty-branch-session")?.messages.size,
          1,
          "agent history should include the first user message",
        );
        assertEqual(
          uiHistory.getMessages("empty-branch-session").length,
          1,
          "UI history should include the first user message",
        );
      },
    );

    await runCase(
      "branch through a UI-only user message keeps agent history through the previous anchor",
      () => {
        uiHistory.recordEvent("source-session", {
          type: "user_input",
          content: "third user only in UI",
          messageId: "backend-user-ui-only",
        } as any);
        uiHistory.flush("source-session");

        const result = agent.branchFromMessage(
          "source-session",
          "backend-user-ui-only",
          "ui-only-branch-session",
        );

        assertEqual(result.ok, true, "UI-only target branch should succeed");
        assertEqual(
          chatHistory.loadSession("ui-only-branch-session")?.messages.size,
          4,
          "agent history should include messages through the previous matching UI anchor",
        );
        assertEqual(
          uiHistory.getMessages("ui-only-branch-session").length,
          5,
          "UI branch should include the UI-only selected user message",
        );
        assertEqual(
          uiHistory
            .getMessages("ui-only-branch-session")
            .some(
              (message) => message.backendMessageId === "backend-user-ui-only",
            ),
          true,
          "UI-only selected user message must be included in branch UI history",
        );
      },
    );

    await runCase(
      "missing branch target does not create a partial session",
      () => {
        const result = agent.branchFromMessage(
          "source-session",
          "missing-message",
          "missing-target-branch",
        );
        assertEqual(result.ok, false, "missing target should fail");
        assertEqual(
          chatHistory.loadSession("missing-target-branch"),
          null,
          "failed branch must not create agent history",
        );
        assertEqual(
          uiHistory.getSession("missing-target-branch"),
          null,
          "failed branch must not create UI history",
        );
      },
    );
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
