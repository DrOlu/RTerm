import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AIMessage,
  HumanMessage,
  mapChatMessagesToStoredMessages,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { AgentService_v2 } from "./AgentService_v2";
import { ChatHistoryService } from "./ChatHistoryService";
import { PassChatTempExportService } from "./PassChatTempExportService";
import { UIHistoryService } from "./UIHistoryService";
import { TokenManager } from "./AgentHelper/TokenManager";
import {
  PASS_CHAT_HISTORY_TAG,
  USER_INPUT_TAG,
  WHAT_HAVE_DONE_IN_THE_PAST_TAG,
} from "./AgentHelper/prompts";
import { buildDynamicRequestHistory } from "./AgentHelper/utils/model_messages";
import { buildDeterministicCompactionDigest } from "./AgentHelper/utils/deterministic_compaction_digest";
import { HistorySqliteStore } from "./history/HistorySqliteStore";

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

class FakeTerminalService {
  constructor(private readonly hasLocalTerminal: boolean = true) {}

  getDisplayTerminals(): any[] {
    if (!this.hasLocalTerminal) return [];
    return [
      {
        id: "local-main",
        title: "Local",
        type: "local",
        capabilities: { supportsFilesystem: true },
      },
    ];
  }

  getTerminalRuntimeSnapshot(): any {
    return this.hasLocalTerminal ? { canUseFilesystem: true } : null;
  }
}

const makeId = (id: string): Record<string, unknown> => ({
  _gyshellMessageId: id,
});

const makeUser = (id: string, content: string): HumanMessage =>
  new HumanMessage({
    content: `${USER_INPUT_TAG}${content}`,
    additional_kwargs: makeId(id),
  });

const makeAssistant = (id: string, content: string): AIMessage =>
  new AIMessage({
    content,
    additional_kwargs: makeId(id),
  });

const makeTool = (id: string, content: string): ToolMessage =>
  new ToolMessage({
    content,
    name: "exec_command",
    tool_call_id: `call-${id}`,
    additional_kwargs: makeId(id),
  } as any);

const makePrunedTool = (id: string, content: string): ToolMessage =>
  new ToolMessage({
    content,
    name: "exec_command",
    tool_call_id: `call-${id}`,
    additional_kwargs: {
      ...makeId(id),
      [TokenManager.PRUNE_FLAG_KEY]: true,
    },
  } as any);

const makeMessages = (): BaseMessage[] => [
  new SystemMessage({
    content: "System instruction",
    additional_kwargs: makeId("backend-system"),
  }),
  makeUser("backend-user-1", "first historical request"),
  makeAssistant("backend-assistant-1", "first historical answer"),
  makeTool(
    "backend-tool-1",
    `command output head\n${"x".repeat(4_000)}\ncommand output tail`,
  ),
  makeUser("backend-user-2", "second historical request"),
  makeAssistant("backend-assistant-2", "second historical answer"),
  makeUser("backend-user-3", "third protected request"),
  makeAssistant("backend-assistant-3", "third protected answer"),
  makeUser("backend-user-4", "fourth protected request"),
];

const seedUiHistory = (
  uiHistory: UIHistoryService,
  options?: { omitProtectedAnchor?: boolean },
): void => {
  const sessionId = "session-1";
  uiHistory.recordEvent(sessionId, {
    type: "user_input",
    content: "first historical request",
    messageId: "backend-user-1",
  } as any);
  uiHistory.recordEvent(sessionId, {
    type: "say",
    content: "first historical answer",
    messageId: "backend-assistant-1",
  } as any);
  uiHistory.recordEvent(sessionId, {
    type: "command_started",
    command: "npm test",
    commandId: "cmd-1",
    messageId: "backend-tool-1",
  } as any);
  uiHistory.recordEvent(sessionId, {
    type: "command_finished",
    commandId: "cmd-1",
    exitCode: 0,
    outputDelta: "command output tail",
    messageId: "backend-tool-1",
  } as any);
  uiHistory.recordEvent(sessionId, {
    type: "user_input",
    content: "second historical request",
    messageId: "backend-user-2",
  } as any);
  uiHistory.recordEvent(sessionId, {
    type: "say",
    content: "second historical answer",
    messageId: "backend-assistant-2",
  } as any);

  if (!options?.omitProtectedAnchor) {
    uiHistory.recordEvent(sessionId, {
      type: "user_input",
      content: "third protected request",
      messageId: "backend-user-3",
    } as any);
  }
  uiHistory.recordEvent(sessionId, {
    type: "say",
    content: "third protected answer",
    messageId: "backend-assistant-3",
  } as any);
  uiHistory.recordEvent(sessionId, {
    type: "user_input",
    content: "fourth protected request",
    messageId: "backend-user-4",
  } as any);
  uiHistory.flush(sessionId);
  uiHistory.renameSession(sessionId, "Fallback Session");
};

const createAgentHarness = (options?: {
  hasLocalTerminal?: boolean;
  omitProtectedAnchor?: boolean;
}): {
  agent: AgentService_v2;
  tempDir: string;
  events: any[];
  cleanup: () => void;
} => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gyshell-compaction-fallback-"),
  );
  const store = new HistorySqliteStore({
    filePath: path.join(tempDir, "history.sqlite3"),
  });
  const chatHistory = new ChatHistoryService({ store });
  const uiHistory = new UIHistoryService({ store });
  seedUiHistory(uiHistory, {
    omitProtectedAnchor: options?.omitProtectedAnchor,
  });

  const agent = new AgentService_v2(
    new FakeTerminalService(options?.hasLocalTerminal !== false) as any,
    {} as any,
    { getActiveTools: () => [] } as any,
    { getEnabledSkills: async () => [] } as any,
    { getMemorySnapshot: async () => ({ enabled: false, content: "" }) } as any,
    uiHistory,
    chatHistory,
  );
  (agent as any).passChatTempExportService = new PassChatTempExportService({
    baseDir: path.join(tempDir, "pass-chat-exports"),
    maxFiles: 20,
  });
  (agent as any).fallbackCompactionHistoryExportService =
    new PassChatTempExportService({
      baseDir: path.join(tempDir, "fallback-compaction-history"),
      maxFiles: null,
      groupBySession: true,
    });
  const events: any[] = [];
  agent.setEventPublisher((_sessionId, event) => {
    events.push(event);
  });

  return {
    agent,
    tempDir,
    events,
    cleanup: () => {
      store.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
};

const runFallbackCompaction = async (
  agent: AgentService_v2,
  messages: BaseMessage[],
  mode: "throw" | "empty" = "throw",
): Promise<{ changed: boolean; messages: BaseMessage[] }> => {
  (agent as any).getCompactionModelDecision = async () => {
    if (mode === "empty") return { summary: "" };
    throw new Error("compaction input exceeded context");
  };
  return await (agent as any).tryCompactHistory(
    "session-1",
    messages,
    undefined,
  );
};

await runCase(
  "deterministic digest stays inside a hard character budget",
  () => {
    const messages = [
      makeUser("u1", "first request " + "a".repeat(20_000)),
      makeAssistant("a1", "answer " + "b".repeat(20_000)),
      makeTool("t1", "tool " + "c".repeat(20_000)),
    ];
    const result = buildDeterministicCompactionDigest({
      messages,
      totalMessageCount: messages.length,
      protectedTailMessageCount: 2,
      maxChars: 4_000,
    });

    assert.ok(result.digest.length <= 4_000);
    assert.ok(result.digest.includes("Emergency deterministic compaction"));
    assert.ok(result.digest.includes("Selected digest entries"));
  },
);

await runCase(
  "model failure inserts fallback compaction with exported prefix history",
  async () => {
    const { agent, tempDir, events, cleanup } = createAgentHarness();
    try {
      const messages = makeMessages();
      const result = await runFallbackCompaction(agent, messages);

      assert.equal(result.changed, true);
      assert.equal(result.messages.length, messages.length + 1);
      const summary = result.messages.find((message) =>
        TokenManager.hasLastCompactionFlag(message),
      ) as any;
      assert.ok(summary, "fallback summary should be inserted");
      assert.equal(summary.additional_kwargs?.fallback_compaction, true);
      assert.match(String(summary.content), /^WHAT_HAVE_DONE_IN_THE_PAST:/);
      assert.ok(String(summary.content).includes(PASS_CHAT_HISTORY_TAG));
      assert.ok(
        String(summary.content).includes("Markdown Export Path:"),
        "summary should include a hidden exported-history path",
      );

      const pathMatch = String(summary.content).match(
        /Markdown Export Path: (.+)/,
      );
      assert.ok(pathMatch?.[1], "export path should be present");
      const exportPath = pathMatch![1].trim();
      assert.ok(
        exportPath.startsWith(
          path.join(tempDir, "fallback-compaction-history"),
        ),
      );
      assert.match(
        path.basename(exportPath),
        /^pass-chat_[a-f0-9]{12}_[a-f0-9]{12}\.md$/,
      );
      assert.ok(fs.existsSync(exportPath));
      const exported = fs.readFileSync(exportPath, "utf8");
      assert.ok(exported.includes("first historical request"));
      assert.ok(exported.includes("second historical request"));
      assert.ok(!exported.includes("third protected request"));
      assert.ok(!exported.includes("fourth protected request"));

      const insertionIndex = (agent as any).findCompactionInsertionIndex(
        messages,
      );
      assert.equal(
        result.messages[insertionIndex + 1],
        messages[insertionIndex],
        "first protected backend message should remain exact after the summary",
      );
      assert.equal(
        result.messages[result.messages.length - 1],
        messages[messages.length - 1],
        "last protected backend message should remain exact",
      );

      const view = buildDynamicRequestHistory(result.messages);
      assert.ok(TokenManager.estimateMessages(view) < 20_000);
      assert.ok(
        view.some((message) =>
          String(message.content).includes("third protected request"),
        ),
        "protected tail should be model-visible",
      );
      assert.ok(events.some((event) => event.type === "compaction_boundary"));
      assert.ok(events.some((event) => event.type === "sub_tool_finished"));
    } finally {
      cleanup();
    }
  },
);

await runCase("fallback exported history title stays single-line", async () => {
  const { agent, cleanup } = createAgentHarness();
  try {
    (agent as any).uiHistoryService.renameSession(
      "session-1",
      `long fallback title ${"word ".repeat(500)}`,
    );

    const result = await runFallbackCompaction(agent, makeMessages());
    const summary = result.messages.find((message) =>
      TokenManager.hasLastCompactionFlag(message),
    ) as any;
    const lines = String(summary.content).split("\n");
    const titleIndex = lines.findIndex((line) =>
      line.startsWith("Chat Title:"),
    );

    assert.notEqual(titleIndex, -1, "summary should include a chat title");
    assert.equal(
      lines[titleIndex + 1]?.startsWith("Chat Session ID:"),
      true,
      "a clipped chat title must not spill onto unlabeled lines",
    );
    assert.ok(lines[titleIndex].includes("...[truncated "));
  } finally {
    cleanup();
  }
});

await runCase(
  "deleting a session removes durable fallback history exports",
  async () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      const result = await runFallbackCompaction(agent, makeMessages());
      const summary = result.messages.find((message) =>
        TokenManager.hasLastCompactionFlag(message),
      ) as any;
      const pathMatch = String(summary.content).match(
        /Markdown Export Path: (.+)/,
      );
      assert.ok(pathMatch?.[1], "export path should be present");
      const exportPath = pathMatch![1].trim();
      assert.ok(fs.existsSync(exportPath));

      agent.deleteChatSession("session-1");

      assert.equal(fs.existsSync(exportPath), false);
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "rollback removes only unreferenced fallback history exports",
  async () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      const exportPath = await (
        agent as any
      ).fallbackCompactionHistoryExportService.exportMarkdown({
        sessionId: "rollback-session",
        title: "Rollback fallback history",
        markdown: "# Rollback fallback history\nexact old detail",
      });
      const summary = new HumanMessage({
        content: `${WHAT_HAVE_DONE_IN_THE_PAST_TAG}summary\n\n${PASS_CHAT_HISTORY_TAG}Markdown Export Path: ${exportPath}\nInstruction: read if needed.\n`,
        additional_kwargs: {
          _gyshellMessageId: "rollback-summary",
          [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
          fallback_compaction: true,
        },
      });
      const userOne = makeUser("rollback-user-1", "protected one");
      const assistantOne = makeAssistant("rollback-assistant-1", "answer one");
      const userTwo = makeUser("rollback-user-2", "protected two");
      const assistantTwo = makeAssistant("rollback-assistant-2", "answer two");
      const storedMessages = mapChatMessagesToStoredMessages([
        summary,
        userOne,
        assistantOne,
        userTwo,
        assistantTwo,
      ]) as any[];
      (agent as any).chatHistoryService.saveSession({
        id: "rollback-session",
        title: "Rollback Session",
        lastCheckpointOffset: 0,
        messages: new Map([
          ["rollback-summary", storedMessages[0]],
          ["rollback-user-1", storedMessages[1]],
          ["rollback-assistant-1", storedMessages[2]],
          ["rollback-user-2", storedMessages[3]],
          ["rollback-assistant-2", storedMessages[4]],
        ]),
      });

      assert.ok(fs.existsSync(exportPath));
      const keepResult = agent.rollbackToMessage(
        "rollback-session",
        "rollback-assistant-2",
      );
      assert.equal(keepResult.ok, true);
      assert.ok(
        fs.existsSync(exportPath),
        "rollback that keeps the summary should keep its export",
      );

      const removeResult = agent.rollbackToMessage(
        "rollback-session",
        "rollback-summary",
      );
      assert.equal(removeResult.ok, true);
      assert.equal(
        fs.existsSync(exportPath),
        false,
        "rollback that removes the fallback summary should delete its export",
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "rollback ignores fallback export paths owned by another session",
  async () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      const otherSessionPath = await (
        agent as any
      ).fallbackCompactionHistoryExportService.exportMarkdown({
        sessionId: "other-rollback-session",
        title: "Other rollback fallback history",
        markdown: "# Other rollback fallback history\n",
      });
      const summary = new HumanMessage({
        content: `${WHAT_HAVE_DONE_IN_THE_PAST_TAG}summary\n\n${PASS_CHAT_HISTORY_TAG}Markdown Export Path: ${otherSessionPath}\nInstruction: read if needed.\n`,
        additional_kwargs: {
          _gyshellMessageId: "cross-rollback-summary",
          [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
          fallback_compaction: true,
        },
      });
      const user = makeUser("cross-rollback-user", "protected one");
      const assistant = makeAssistant("cross-rollback-assistant", "answer one");
      const storedMessages = mapChatMessagesToStoredMessages([
        summary,
        user,
        assistant,
      ]) as any[];
      (agent as any).chatHistoryService.saveSession({
        id: "rollback-cross-session",
        title: "Rollback Cross Session",
        lastCheckpointOffset: 0,
        messages: new Map([
          ["cross-rollback-summary", storedMessages[0]],
          ["cross-rollback-user", storedMessages[1]],
          ["cross-rollback-assistant", storedMessages[2]],
        ]),
      });

      assert.ok(fs.existsSync(otherSessionPath));

      const removeResult = agent.rollbackToMessage(
        "rollback-cross-session",
        "cross-rollback-summary",
      );

      assert.equal(removeResult.ok, true);
      assert.equal(
        fs.existsSync(otherSessionPath),
        true,
        "rollback must not delete a fallback export owned by another session",
      );
    } finally {
      cleanup();
    }
  },
);

await runCase("empty model summary also uses fallback compaction", async () => {
  const { agent, cleanup } = createAgentHarness();
  try {
    const result = await runFallbackCompaction(agent, makeMessages(), "empty");
    const summary = result.messages.find((message) =>
      TokenManager.hasLastCompactionFlag(message),
    ) as any;

    assert.equal(result.changed, true);
    assert.equal(summary.additional_kwargs?.fallback_compaction, true);
    assert.ok(
      String(summary.content).includes(
        "Compaction model failure reason: empty compaction summary",
      ),
    );
  } finally {
    cleanup();
  }
});

await runCase(
  "fallback compaction survives missing UI anchor without exporting tail",
  async () => {
    const { agent, cleanup } = createAgentHarness({
      omitProtectedAnchor: true,
    });
    try {
      const result = await runFallbackCompaction(agent, makeMessages());
      const summary = result.messages.find((message) =>
        TokenManager.hasLastCompactionFlag(message),
      ) as any;

      assert.equal(result.changed, true);
      assert.ok(
        String(summary.content).includes(
          "protected-tail UI anchor was not found",
        ),
      );
      assert.ok(
        !String(summary.content).includes("Markdown Export Path:"),
        "missing anchor should not export an imprecise history slice",
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "fallback digest respects previous compaction and pruned tool materialization",
  async () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      const previousSummary = new HumanMessage({
        content: `${WHAT_HAVE_DONE_IN_THE_PAST_TAG}previous compacted safe summary`,
        additional_kwargs: {
          _gyshellMessageId: "backend-previous-summary",
          [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
        },
      });
      const messages: BaseMessage[] = [
        new SystemMessage({
          content: "System instruction",
          additional_kwargs: makeId("backend-system"),
        }),
        makeUser("backend-old-hidden-user", "RAW_BEFORE_LAST_COMPACTION"),
        makePrunedTool(
          "backend-old-hidden-tool",
          "RAW_PRUNED_BEFORE_LAST_COMPACTION",
        ),
        previousSummary,
        makeUser("backend-visible-user-1", "visible historical request 1"),
        makePrunedTool(
          "backend-visible-pruned-tool",
          "RAW_PRUNED_AFTER_LAST_COMPACTION",
        ),
        makeAssistant("backend-visible-assistant-1", "visible answer 1"),
        makeUser("backend-visible-user-2", "visible historical request 2"),
        makeAssistant("backend-visible-assistant-2", "visible answer 2"),
        makeUser("backend-protected-user-1", "protected request 1"),
        makeAssistant("backend-protected-assistant-1", "protected answer 1"),
        makeUser("backend-protected-user-2", "protected request 2"),
      ];

      const result = await runFallbackCompaction(agent, messages);
      const summary = [...result.messages]
        .reverse()
        .find((message) => TokenManager.hasLastCompactionFlag(message)) as any;
      const content = String(summary.content);

      assert.ok(content.includes("previous compacted safe summary"));
      assert.ok(content.includes(TokenManager.PRUNED_CONTENT_PLACEHOLDER));
      assert.ok(!content.includes("RAW_BEFORE_LAST_COMPACTION"));
      assert.ok(!content.includes("RAW_PRUNED_BEFORE_LAST_COMPACTION"));
      assert.ok(!content.includes("RAW_PRUNED_AFTER_LAST_COMPACTION"));
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "fallback summary stays under hard cap with huge failure diagnostics",
  async () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      (agent as any).uiHistoryService.renameSession(
        "session-1",
        "huge title ".repeat(30_000),
      );
      (agent as any).getCompactionModelDecision = async () => {
        throw new Error("huge provider error ".repeat(30_000));
      };

      const result = await (agent as any).tryCompactHistory(
        "session-1",
        makeMessages(),
        undefined,
      );
      const summary = result.messages.find((message: BaseMessage) =>
        TokenManager.hasLastCompactionFlag(message),
      ) as any;
      const content = String(summary.content);

      assert.equal(result.changed, true);
      assert.ok(
        content.length <= 60_000 + WHAT_HAVE_DONE_IN_THE_PAST_TAG.length,
      );
      assert.ok(content.includes("Markdown Export Path:"));
      assert.ok(content.includes("huge provider error"));
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "fallback guidance handles unavailable local terminal",
  async () => {
    const { agent, cleanup } = createAgentHarness({
      hasLocalTerminal: false,
    });
    try {
      const result = await runFallbackCompaction(agent, makeMessages());
      const summary = result.messages.find((message) =>
        TokenManager.hasLastCompactionFlag(message),
      ) as any;

      assert.ok(
        String(summary.content).includes(
          "Recommended Local Terminal Tab: unavailable",
        ),
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "abort errors do not trigger deterministic fallback",
  async () => {
    const { agent, events, cleanup } = createAgentHarness();
    try {
      const abortError = new Error("AbortError");
      abortError.name = "AbortError";
      (agent as any).getCompactionModelDecision = async () => {
        throw abortError;
      };

      await assert.rejects(
        () =>
          (agent as any).tryCompactHistory(
            "session-1",
            makeMessages(),
            undefined,
          ),
        /AbortError/,
      );
      assert.ok(!events.some((event) => event.type === "compaction_boundary"));
      assert.ok(events.some((event) => event.type === "sub_tool_finished"));
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "abort during deterministic fallback does not insert compaction marker",
  async () => {
    const { agent, events, cleanup } = createAgentHarness();
    try {
      const controller = new AbortController();
      (agent as any).getCompactionModelDecision = async () => {
        throw new Error("compaction input exceeded context");
      };
      const exportService = (agent as any)
        .fallbackCompactionHistoryExportService;
      const originalExportMarkdown =
        exportService.exportMarkdown.bind(exportService);
      let exportedPath: string | null = null;
      exportService.exportMarkdown = async (input: any) => {
        exportedPath = await originalExportMarkdown(input);
        controller.abort();
        return exportedPath;
      };

      await assert.rejects(
        () =>
          (agent as any).tryCompactHistory(
            "session-1",
            makeMessages(),
            controller.signal,
          ),
        /AbortError/,
      );

      assert.ok(!events.some((event) => event.type === "compaction_boundary"));
      assert.ok(events.some((event) => event.type === "sub_tool_finished"));
      assert.ok(exportedPath, "the abort test should write an export first");
      assert.equal(
        fs.existsSync(exportedPath),
        false,
        "aborting after export must clean up the unreferenced export",
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "abort after model summary success finishes compaction progress",
  async () => {
    const { agent, events, cleanup } = createAgentHarness();
    try {
      const controller = new AbortController();
      (agent as any).getCompactionModelDecision = async () => {
        controller.abort();
        return { summary: "model summary" };
      };

      await assert.rejects(
        () =>
          (agent as any).tryCompactHistory(
            "session-1",
            makeMessages(),
            controller.signal,
          ),
        /AbortError/,
      );

      assert.ok(!events.some((event) => event.type === "compaction_boundary"));
      assert.ok(events.some((event) => event.type === "sub_tool_finished"));
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "existing compaction marker still compacts request view after profile max increase",
  () => {
    const messages = makeMessages();
    const summary = new HumanMessage({
      content: `${WHAT_HAVE_DONE_IN_THE_PAST_TAG}previous summary`,
      additional_kwargs: {
        _gyshellMessageId: "backend-summary",
        [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
      },
    });
    const withMarker = [...messages.slice(0, 4), summary, ...messages.slice(4)];
    const view = buildDynamicRequestHistory(withMarker);

    assert.ok(
      view.some((message) => TokenManager.hasLastCompactionFlag(message)),
    );
    assert.ok(
      !view.some((message) =>
        String(message.content).includes("first historical request"),
      ),
      "request view should keep the last compaction boundary instead of expanding old history",
    );
    assert.ok(
      view.some((message) =>
        String(message.content).includes("third protected request"),
      ),
    );
  },
);
