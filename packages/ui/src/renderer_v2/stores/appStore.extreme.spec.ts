import { AppStore } from "./AppStore";
import { ChatStore } from "./ChatStore";
import type { LayoutTree } from "../layout";

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

const buildPersistedTree = (options?: {
  focusedPanelId?: string;
}): LayoutTree => ({
  schemaVersion: 2,
  root: {
    type: "split",
    id: "root",
    direction: "horizontal",
    children: [
      {
        type: "panel",
        id: "node-chat-a",
        panel: { id: "panel-chat-a", kind: "chat" },
      },
      {
        type: "panel",
        id: "node-chat-b",
        panel: { id: "panel-chat-b", kind: "chat" },
      },
      {
        type: "panel",
        id: "node-terminal",
        panel: { id: "panel-terminal", kind: "terminal" },
      },
    ],
    sizes: [34, 33, 33],
  },
  focusedPanelId: options?.focusedPanelId || "panel-chat-b",
  panelTabs: {
    "panel-chat-a": {
      tabIds: ["chat-a"],
      activeTabId: "chat-a",
    },
    "panel-chat-b": {
      tabIds: ["chat-b", "chat-c"],
      activeTabId: "chat-c",
    },
    "panel-terminal": {
      tabIds: ["term-a"],
      activeTabId: "term-a",
    },
  },
});

const installBootstrapWindowMock = (
  layoutTree: LayoutTree,
  options?: {
    allChatHistory?: Array<{ id: string; title?: string }>;
    uiMessagesBySessionId?: Record<string, any[]>;
    getUiMessages?: (sessionId: string) => Promise<any[]>;
    runtimeSnapshotsBySessionId?: Record<string, any>;
    onUiUpdateRegister?: (callback: (action: any) => void) => void;
    loadChatSessionCalls?: string[];
  },
): void => {
  const versionPayload = {
    status: "up-to-date",
    currentVersion: "1.0.0",
    latestVersion: "1.0.0",
  };

  (globalThis as unknown as { document: unknown }).document = {
    documentElement: {
      style: {
        setProperty: () => {},
      },
    },
  };
  (globalThis as unknown as { window: unknown }).window = {
    gyshell: {
      settings: {
        get: async () => ({
          themeId: "gyshell-dark",
          language: "en",
          layout: {
            v2: layoutTree,
          },
        }),
        set: async () => {},
        setWsGatewayConfig: async (ws: {
          access: string;
          port: number;
          allowedCidrs?: string[];
        }) => ws,
      },
      mobileWeb: {
        getStatus: async () => ({ running: false }),
        start: async () => ({ running: true }),
        stop: async () => ({ ok: true }),
        setPort: async () => ({ ok: true }),
      },
      uiSettings: {
        get: async () => ({}),
      },
      themes: {
        getCustom: async () => [],
      },
      agent: {
        onUiUpdate: (callback: (action: any) => void) => {
          options?.onUiUpdateRegister?.(callback);
        },
        getAllChatHistory: async () => options?.allChatHistory || [],
        getUiMessages: async (sessionId: string) => {
          if (options?.getUiMessages) {
            return await options.getUiMessages(sessionId);
          }
          return options?.uiMessagesBySessionId?.[sessionId] || [];
        },
        getSessionSnapshot: async (sessionId: string) =>
          options?.runtimeSnapshotsBySessionId?.[sessionId] || {
            id: sessionId,
            isBusy: false,
            lockedProfileId: null,
          },
        loadChatSession: async (sessionId: string) => {
          options?.loadChatSessionCalls?.push(sessionId);
          return null;
        },
      },
      terminal: {
        onExit: () => {},
        onTabsUpdated: () => {},
        list: async () => ({
          terminals: [
            {
              id: "term-a",
              title: "Local",
              type: "local",
              cols: 80,
              rows: 24,
              runtimeState: "ready",
            },
          ],
        }),
      },
      tools: {
        onMcpUpdated: () => {},
        onBuiltInUpdated: () => {},
      },
      skills: {
        onUpdated: () => {},
      },
      memory: {
        get: async () => ({
          filePath: "",
          content: "",
        }),
      },
      accessTokens: {
        list: async () => [],
      },
      version: {
        getState: async () => versionPayload,
        check: async () => versionPayload,
      },
    },
  };
};

const run = async (): Promise<void> => {
  await runCase(
    "collectPersistedChatInventoryState preserves focused chat active tab",
    async () => {
      const store = new AppStore();
      const layoutTree = buildPersistedTree({
        focusedPanelId: "panel-chat-b",
      });

      const state = (store as any).collectPersistedChatInventoryState({
        v2: layoutTree,
      });
      assertEqual(
        JSON.stringify(state.tabIds),
        JSON.stringify(["chat-a", "chat-b", "chat-c"]),
        "chat tab ids should preserve persisted ordering by panel binding",
      );
      assertEqual(
        state.preferredActiveTabId,
        "chat-c",
        "focused chat panel active tab should be restored as preferred active tab",
      );
    },
  );

  await runCase(
    "collectPersistedChatInventoryState falls back to first available active chat tab",
    async () => {
      const store = new AppStore();
      const layoutTree = buildPersistedTree({
        focusedPanelId: "panel-terminal",
      });

      const state = (store as any).collectPersistedChatInventoryState({
        v2: layoutTree,
      });
      assertEqual(
        state.preferredActiveTabId,
        "chat-a",
        "first available active chat tab should be used when focused panel is not chat",
      );
    },
  );

  await runCase(
    "ChatStore hydration honors preferred active session id",
    async () => {
      const chatStore = new ChatStore();
      chatStore.hydrateSessionInventoryFromLayout(
        ["chat-a", "chat-b", "chat-c"],
        "chat-c",
      );
      assertEqual(
        chatStore.activeSessionId,
        "chat-c",
        "preferred active chat session should win over default first tab fallback",
      );
    },
  );

  await runCase(
    "AppStore bootstrap passes preferred active chat id into hydration",
    async () => {
      const layoutTree = buildPersistedTree({
        focusedPanelId: "panel-chat-b",
      });
      installBootstrapWindowMock(layoutTree);

      const store = new AppStore();
      (store.layout as any).bootstrap = () => {};
      (store.layout as any).syncPanelBindings = () => {};
      (store as any).loadTools = async () => {};
      (store as any).loadSkills = async () => {};
      (store as any).loadMemory = async () => {};
      (store as any).loadCommandPolicyLists = async () => {};
      (store as any).loadAccessTokens = async () => {};
      (store as any).loadVersionState = async () => {};
      (store as any).checkVersion = async () => {};

      const originalHydrate = store.chat.hydrateSessionInventoryFromLayout.bind(
        store.chat,
      );
      let capturedHydrationArgs: {
        tabIds: string[];
        preferredActiveSessionId: string | null;
      } | null = null;
      store.chat.hydrateSessionInventoryFromLayout = ((
        tabIds: string[],
        preferredActiveSessionId?: string | null,
      ) => {
        capturedHydrationArgs = {
          tabIds: [...tabIds],
          preferredActiveSessionId: preferredActiveSessionId ?? null,
        };
        originalHydrate(tabIds, preferredActiveSessionId);
      }) as ChatStore["hydrateSessionInventoryFromLayout"];

      await store.bootstrap();
      assertCondition(
        !!capturedHydrationArgs,
        "bootstrap should hydrate chat inventory exactly once",
      );
      const hydrationArgs = capturedHydrationArgs || {
        tabIds: [],
        preferredActiveSessionId: null,
      };
      assertEqual(
        JSON.stringify(hydrationArgs.tabIds),
        JSON.stringify(["chat-a", "chat-b", "chat-c"]),
        "bootstrap should pass persisted chat tab ids in deterministic order",
      );
      assertEqual(
        hydrationArgs.preferredActiveSessionId,
        "chat-c",
        "bootstrap should pass preferred active chat session id to hydration",
      );
    },
  );

  await runCase(
    "AppStore bootstrap hydrates restored chat tabs with persisted titles/messages",
    async () => {
      const layoutTree = buildPersistedTree({
        focusedPanelId: "panel-chat-b",
      });
      const loadChatSessionCalls: string[] = [];
      installBootstrapWindowMock(layoutTree, {
        allChatHistory: [
          { id: "chat-a", title: "Alpha Chat" },
          { id: "chat-b", title: "Beta Chat" },
          { id: "chat-c", title: "Gamma Chat" },
        ],
        uiMessagesBySessionId: {
          "chat-a": [
            {
              id: "msg-a1",
              role: "user",
              type: "text",
              content: "hello",
              timestamp: 1,
            },
          ],
          "chat-b": [
            {
              id: "msg-b1",
              role: "assistant",
              type: "text",
              content: "ok",
              timestamp: 2,
            },
          ],
          "chat-c": [
            {
              id: "msg-c1",
              role: "user",
              type: "text",
              content: "resume",
              timestamp: 3,
            },
          ],
        },
        runtimeSnapshotsBySessionId: {
          "chat-c": {
            id: "chat-c",
            isBusy: true,
            lockedProfileId: "profile-1",
          },
        },
        loadChatSessionCalls,
      });

      const store = new AppStore();
      (store.layout as any).bootstrap = () => {};
      (store.layout as any).syncPanelBindings = () => {};
      (store as any).loadTools = async () => {};
      (store as any).loadSkills = async () => {};
      (store as any).loadMemory = async () => {};
      (store as any).loadCommandPolicyLists = async () => {};
      (store as any).loadAccessTokens = async () => {};
      (store as any).loadVersionState = async () => {};
      (store as any).checkVersion = async () => {};

      await store.bootstrap();

      assertEqual(
        store.chat.getSessionById("chat-a")?.title,
        "Alpha Chat",
        "restored chat-a title should be hydrated",
      );
      assertEqual(
        store.chat.getSessionById("chat-b")?.title,
        "Beta Chat",
        "restored chat-b title should be hydrated",
      );
      assertEqual(
        store.chat.getSessionById("chat-c")?.title,
        "Gamma Chat",
        "restored chat-c title should be hydrated",
      );
      assertEqual(
        store.chat.getSessionById("chat-c")?.messageIds.length,
        1,
        "restored chat-c messages should be hydrated",
      );
      assertEqual(
        store.chat.activeSessionId,
        "chat-c",
        "preferred active restored tab should stay active after hydration",
      );
      assertEqual(
        JSON.stringify(loadChatSessionCalls),
        JSON.stringify(["chat-c"]),
        "bootstrap should load runtime backend context for active restored chat session",
      );
    },
  );

  await runCase(
    "reconcileTerminalTabs pins unresolved terminal panels only on first hydration",
    async () => {
      const store = new AppStore();
      let missingCallCount = 0;
      let pinCallCount = 0;
      let capturedIncomingIds: string[] = [];
      let capturedPinnedPanels: string[] = [];

      (store.layout as any).getPanelsWithMissingTabBindings = (
        _kind: string,
        ownerTabIds: string[],
      ) => {
        missingCallCount += 1;
        capturedIncomingIds = [...ownerTabIds];
        return ["panel-term-missing"];
      };
      (store.layout as any).pinPanelsAsRestorePlaceholder = (
        panelIds: string[],
      ) => {
        pinCallCount += 1;
        capturedPinnedPanels = [...panelIds];
      };
      (store.layout as any).syncPanelBindings = () => {};

      store.reconcileTerminalTabs({
        terminals: [
          {
            id: "term-1",
            title: "Local",
            type: "local",
            cols: 80,
            rows: 24,
            runtimeState: "ready",
          },
        ],
      } as any);

      assertEqual(
        missingCallCount,
        1,
        "first hydration should detect unresolved terminal panels",
      );
      assertEqual(
        pinCallCount,
        1,
        "first hydration should pin unresolved terminal panels",
      );
      assertEqual(
        JSON.stringify(capturedIncomingIds),
        JSON.stringify(["term-1"]),
        "incoming ids should be forwarded to layout",
      );
      assertEqual(
        JSON.stringify(capturedPinnedPanels),
        JSON.stringify(["panel-term-missing"]),
        "layout should receive unresolved panel ids",
      );

      store.reconcileTerminalTabs({
        terminals: [
          {
            id: "term-1",
            title: "Local",
            type: "local",
            cols: 120,
            rows: 40,
            runtimeState: "ready",
          },
        ],
      } as any);

      assertEqual(
        missingCallCount,
        1,
        "subsequent updates should not re-run first hydration placeholder detection",
      );
      assertEqual(
        pinCallCount,
        1,
        "subsequent updates should not re-pin placeholders",
      );
    },
  );

  await runCase(
    "AppStore bootstrap should buffer ui updates emitted during chat hydration",
    async () => {
      const layoutTree = buildPersistedTree({
        focusedPanelId: "panel-chat-b",
      });
      let uiUpdateHandler: ((action: any) => void) | null = null;
      let resolveHydrationGate: (() => void) | null = null;
      const hydrationGate = new Promise<void>((resolve) => {
        resolveHydrationGate = resolve;
      });

      installBootstrapWindowMock(layoutTree, {
        allChatHistory: [
          { id: "chat-a", title: "Alpha Chat" },
          { id: "chat-b", title: "Beta Chat" },
          { id: "chat-c", title: "Gamma Chat" },
        ],
        onUiUpdateRegister: (callback) => {
          uiUpdateHandler = callback;
        },
        getUiMessages: async (sessionId: string) => {
          if (sessionId === "chat-c") {
            await hydrationGate;
          }
          return [];
        },
      });

      const store = new AppStore();
      (store.layout as any).bootstrap = () => {};
      (store.layout as any).syncPanelBindings = () => {};
      (store as any).loadTools = async () => {};
      (store as any).loadSkills = async () => {};
      (store as any).loadMemory = async () => {};
      (store as any).loadCommandPolicyLists = async () => {};
      (store as any).loadAccessTokens = async () => {};
      (store as any).loadVersionState = async () => {};
      (store as any).checkVersion = async () => {};

      const bootstrapPromise = store.bootstrap();
      for (let i = 0; i < 20 && !uiUpdateHandler; i += 1) {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assertCondition(
        !!uiUpdateHandler,
        "bootstrap should register ui update listener before hydration awaits",
      );

      uiUpdateHandler!({
        type: "ADD_MESSAGE",
        sessionId: "chat-c",
        message: {
          id: "msg-during-hydration",
          role: "assistant",
          type: "text",
          content: "streaming while hydrating",
          timestamp: 10,
        },
      });

      resolveHydrationGate!();

      await bootstrapPromise;

      const restoredSession = store.chat.getSessionById("chat-c");
      assertCondition(
        !!restoredSession,
        "restored session should exist after bootstrap",
      );
      assertCondition(
        restoredSession?.messageIds.includes("msg-during-hydration"),
        "ui update emitted during hydration should be replayed after hydration",
      );
    },
  );

  await runCase(
    "AppStore bootstrap replay should not duplicate messages already present in hydrated snapshot",
    async () => {
      const layoutTree = buildPersistedTree({
        focusedPanelId: "panel-chat-b",
      });
      let uiUpdateHandler: ((action: any) => void) | null = null;
      let resolveHydrationGate: (() => void) | null = null;
      const hydrationGate = new Promise<void>((resolve) => {
        resolveHydrationGate = resolve;
      });

      installBootstrapWindowMock(layoutTree, {
        allChatHistory: [
          { id: "chat-a", title: "Alpha Chat" },
          { id: "chat-b", title: "Beta Chat" },
          { id: "chat-c", title: "Gamma Chat" },
        ],
        onUiUpdateRegister: (callback) => {
          uiUpdateHandler = callback;
        },
        getUiMessages: async (sessionId: string) => {
          if (sessionId === "chat-c") {
            await hydrationGate;
            return [
              {
                id: "msg-shared",
                role: "assistant",
                type: "text",
                content: "shared message",
                timestamp: 20,
              },
            ];
          }
          return [];
        },
      });

      const store = new AppStore();
      (store.layout as any).bootstrap = () => {};
      (store.layout as any).syncPanelBindings = () => {};
      (store as any).loadTools = async () => {};
      (store as any).loadSkills = async () => {};
      (store as any).loadMemory = async () => {};
      (store as any).loadCommandPolicyLists = async () => {};
      (store as any).loadAccessTokens = async () => {};
      (store as any).loadVersionState = async () => {};
      (store as any).checkVersion = async () => {};

      const bootstrapPromise = store.bootstrap();
      for (let i = 0; i < 20 && !uiUpdateHandler; i += 1) {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assertCondition(
        !!uiUpdateHandler,
        "bootstrap should register ui update listener before hydration awaits",
      );

      uiUpdateHandler!({
        type: "ADD_MESSAGE",
        sessionId: "chat-c",
        message: {
          id: "msg-shared",
          role: "assistant",
          type: "text",
          content: "shared message",
          timestamp: 20,
        },
      });

      resolveHydrationGate!();
      await bootstrapPromise;

      const restoredSession = store.chat.getSessionById("chat-c");
      assertCondition(
        !!restoredSession,
        "restored session should exist after bootstrap",
      );
      const duplicateCount =
        restoredSession?.messageIds.filter((id) => id === "msg-shared")
          .length || 0;
      assertEqual(
        duplicateCount,
        1,
        "deferred replay should not duplicate hydrated message ids",
      );
    },
  );

  await runCase(
    "canClosePanel blocks dirty file editor when user cancels discard",
    async () => {
      const originalWindow = (globalThis as any).window;
      let confirmCalled = 0;
      (globalThis as any).window = {
        confirm: () => {
          confirmCalled += 1;
          return false;
        },
      };
      try {
        const store = new AppStore();
        (store.fileEditor as any).mode = "text";
        (store.fileEditor as any).dirty = true;
        const allowed = store.canClosePanel("fileEditor");
        assertEqual(
          allowed,
          false,
          "dirty editor close should be rejected when user cancels",
        );
        assertEqual(
          confirmCalled,
          1,
          "dirty editor close should ask for confirmation once",
        );
      } finally {
        (globalThis as any).window = originalWindow;
      }
    },
  );

  await runCase(
    "canClosePanel allows close without prompt when editor is clean",
    async () => {
      const originalWindow = (globalThis as any).window;
      let confirmCalled = 0;
      (globalThis as any).window = {
        confirm: () => {
          confirmCalled += 1;
          return true;
        },
      };
      try {
        const store = new AppStore();
        (store.fileEditor as any).mode = "text";
        (store.fileEditor as any).dirty = false;
        const allowed = store.canClosePanel("fileEditor");
        assertEqual(
          allowed,
          true,
          "clean editor close should pass immediately",
        );
        assertEqual(
          confirmCalled,
          0,
          "clean editor close should not prompt for confirmation",
        );
      } finally {
        (globalThis as any).window = originalWindow;
      }
    },
  );

  await runCase(
    "fileSystemTabs inventory includes both local and ssh terminal tabs",
    async () => {
      const store = new AppStore();
      (store.layout as any).syncPanelBindings = () => {};
      store.reconcileTerminalTabs({
        terminals: [
          {
            id: "local-1",
            title: "Local",
            type: "local",
            cols: 80,
            rows: 24,
            runtimeState: "ready",
          },
          {
            id: "ssh-1",
            title: "SSH",
            type: "ssh",
            cols: 120,
            rows: 32,
            runtimeState: "ready",
          },
        ],
      } as any);

      assertEqual(
        store.fileSystemTabs.length,
        2,
        "filesystem inventory should include local and ssh tabs",
      );
      assertCondition(
        store.fileSystemTabs.some((tab) => tab.config.type === "local"),
        "filesystem inventory should include local tab",
      );
      assertCondition(
        store.fileSystemTabs.some((tab) => tab.config.type === "ssh"),
        "filesystem inventory should include ssh tab",
      );
    },
  );

  await runCase(
    "detached getOwnedTabIds filters terminal/filesystem to detached-visible tab set",
    async () => {
      const store = new AppStore();
      (store as any).windowRole = "detached";
      (store as any).detachedVisibleTabIdsByKind = {
        chat: new Set<string>(),
        terminal: new Set<string>(["term-b"]),
        filesystem: new Set<string>(["term-b"]),
      };
      (store as any).suppressedTabIdsByKind = {
        chat: new Set<string>(),
        terminal: new Set<string>(),
        filesystem: new Set<string>(),
      };
      store.terminalTabs = [
        {
          id: "term-a",
          title: "Local A",
          config: {
            type: "local",
            id: "term-a",
            title: "Local A",
            cols: 80,
            rows: 24,
          },
          connectionRef: { type: "local" },
          runtimeState: "ready",
        },
        {
          id: "term-b",
          title: "Local B",
          config: {
            type: "local",
            id: "term-b",
            title: "Local B",
            cols: 80,
            rows: 24,
          },
          connectionRef: { type: "local" },
          runtimeState: "ready",
        },
      ];
      store.terminalTabsHydrated = true;

      assertEqual(
        JSON.stringify(store.getOwnedTabIds("terminal")),
        JSON.stringify(["term-b"]),
        "detached terminal owner tabs should be constrained to detached-visible set",
      );
      assertEqual(
        JSON.stringify(store.getOwnedTabIds("filesystem")),
        JSON.stringify(["term-b"]),
        "detached filesystem owner tabs should be constrained to detached-visible set",
      );
    },
  );

  await runCase(
    "detached suppress/unsuppress updates detached-visible tab set for terminal/filesystem",
    async () => {
      const store = new AppStore();
      (store as any).windowRole = "detached";
      (store as any).detachedVisibleTabIdsByKind = {
        chat: new Set<string>(),
        terminal: new Set<string>(["term-a"]),
        filesystem: new Set<string>(["term-a"]),
      };
      store.terminalTabs = [
        {
          id: "term-a",
          title: "Local A",
          config: {
            type: "local",
            id: "term-a",
            title: "Local A",
            cols: 80,
            rows: 24,
          },
          connectionRef: { type: "local" },
          runtimeState: "ready",
        },
        {
          id: "term-b",
          title: "Local B",
          config: {
            type: "local",
            id: "term-b",
            title: "Local B",
            cols: 80,
            rows: 24,
          },
          connectionRef: { type: "local" },
          runtimeState: "ready",
        },
      ];
      store.terminalTabsHydrated = true;
      let syncCallCount = 0;
      (store.layout as any).syncPanelBindings = () => {
        syncCallCount += 1;
      };

      store.unsuppressTabs("terminal", ["term-b"]);
      assertEqual(
        JSON.stringify(store.getOwnedTabIds("terminal")),
        JSON.stringify(["term-a", "term-b"]),
        "unsuppress in detached should make tab visible inside detached terminal owner inventory",
      );
      assertEqual(
        JSON.stringify(store.getOwnedTabIds("filesystem")),
        JSON.stringify(["term-a", "term-b"]),
        "unsuppress in detached should mirror visibility to filesystem owner inventory",
      );

      store.suppressTabs("filesystem", ["term-a"]);
      assertEqual(
        JSON.stringify(store.getOwnedTabIds("terminal")),
        JSON.stringify(["term-b"]),
        "suppress in detached should hide tab from detached terminal owner inventory",
      );
      assertEqual(
        JSON.stringify(store.getOwnedTabIds("filesystem")),
        JSON.stringify(["term-b"]),
        "suppress in detached should hide tab from detached filesystem owner inventory",
      );
      assertCondition(
        syncCallCount >= 2,
        "detached visibility updates should trigger binding sync",
      );
    },
  );

  await runCase(
    "detached new chat sessions become visible to the current window immediately",
    async () => {
      const store = new AppStore();
      (store as any).windowRole = "detached";
      const existingChatIds = store.chat.sessions.map((session) => session.id);
      (store as any).detachedVisibleTabIdsByKind = {
        chat: new Set<string>(existingChatIds),
        terminal: new Set<string>(),
        filesystem: new Set<string>(),
      };
      (store as any).lastKnownChatSessionIds = new Set(existingChatIds);
      let syncCallCount = 0;
      (store.layout as any).syncPanelBindings = () => {
        syncCallCount += 1;
      };

      const sessionId = store.chat.createSession("Detached Chat");

      assertCondition(
        store.getOwnedTabIds("chat").includes(sessionId),
        "new detached chat session should be visible to detached chat owner inventory",
      );
      assertCondition(
        syncCallCount >= 1,
        "new detached chat session should trigger layout binding sync",
      );
    },
  );

  await runCase(
    "ensureTabInventoryEntry materializes missing chat sessions for cross-window drops",
    async () => {
      const store = new AppStore();
      (store as any).windowRole = "detached";
      const existingChatIds = store.chat.sessions.map((session) => session.id);
      (store as any).detachedVisibleTabIdsByKind = {
        chat: new Set<string>(existingChatIds),
        terminal: new Set<string>(),
        filesystem: new Set<string>(),
      };
      (store as any).lastKnownChatSessionIds = new Set(existingChatIds);
      (store.layout as any).syncPanelBindings = () => {};

      store.ensureTabInventoryEntry("chat", "chat-remote-new");

      assertCondition(
        !!store.chat.getSessionById("chat-remote-new"),
        "cross-window chat drop target should create a placeholder session when inventory is missing",
      );
      assertCondition(
        store.getOwnedTabIds("chat").includes("chat-remote-new"),
        "materialized chat session should be immediately visible to detached chat owner inventory",
      );
    },
  );

  await runCase(
    "ensureTabInventoryEntry materializes missing terminal inventory for cross-window drops",
    async () => {
      const store = new AppStore();
      (store.layout as any).syncPanelBindings = () => {};

      store.ensureTabInventoryEntry("terminal", "term-remote-new", {
        terminalTab: {
          id: "term-remote-new",
          title: "Remote Terminal",
          config: {
            type: "local",
            id: "term-remote-new",
            title: "Remote Terminal",
            cols: 80,
            rows: 24,
          },
          connectionRef: { type: "local" },
          runtimeState: "ready",
        },
      });

      assertCondition(
        store.getOwnedTabIds("terminal").includes("term-remote-new"),
        "terminal drop target should seed missing terminal inventory before backend onTabsUpdated arrives",
      );
      assertCondition(
        store.getOwnedTabIds("filesystem").includes("term-remote-new"),
        "filesystem owner inventory should see the same shared terminal placeholder",
      );
    },
  );

  await runCase(
    "materializeTransferredTabs restores detached-created chat sessions before unsuppress",
    async () => {
      const store = new AppStore();
      (store.layout as any).syncPanelBindings = () => {};

      const restoredIds = store.materializeTransferredTabs("chat", [
        "chat-detached-new",
        "chat-detached-new",
      ]);

      assertEqual(
        JSON.stringify(restoredIds),
        JSON.stringify(["chat-detached-new"]),
        "materializeTransferredTabs should normalize duplicate transferred chat ids",
      );
      assertCondition(
        !!store.chat.getSessionById("chat-detached-new"),
        "main window should materialize detached-created chat inventory before unsuppressing it back into layout",
      );
    },
  );

  await runCase(
    "materializeTransferredTabs seeds terminal placeholders from payload snapshots",
    async () => {
      const store = new AppStore();
      (store.layout as any).syncPanelBindings = () => {};

      const restoredIds = store.materializeTransferredTabs(
        "filesystem",
        ["term-fs-remote"],
        {
          terminalTabs: [
            {
              id: "term-fs-remote",
              title: "Shared Terminal",
              config: {
                type: "local",
                id: "term-fs-remote",
                title: "Shared Terminal",
                cols: 120,
                rows: 32,
              },
              connectionRef: { type: "local" },
              runtimeState: "ready",
            },
          ],
        },
      );

      assertEqual(
        JSON.stringify(restoredIds),
        JSON.stringify(["term-fs-remote"]),
        "materializeTransferredTabs should normalize transferred terminal ids",
      );
      assertCondition(
        store.getOwnedTabIds("filesystem").includes("term-fs-remote"),
        "filesystem drop target should keep the transferred terminal placeholder visible",
      );
    },
  );

  await runCase(
    "hydrateTransferredTabEntry hydrates chat history without forcing activation",
    async () => {
      const store = new AppStore();
      let hydratedSessionId: string | null = null;
      let hydrateActivate: boolean | undefined;
      let hydrateLoadAgentContext: boolean | undefined;
      (store.chat as any).hydrateSessionFromBackend = async (
        sessionId: string,
        options?: { activate?: boolean; loadAgentContext?: boolean },
      ) => {
        hydratedSessionId = sessionId;
        hydrateActivate = options?.activate;
        hydrateLoadAgentContext = options?.loadAgentContext;
      };

      store.hydrateTransferredTabEntry("chat", "chat-remote-history");

      await Promise.resolve();

      assertCondition(
        !!store.chat.getSessionById("chat-remote-history"),
        "background hydration should still materialize a placeholder chat session first",
      );
      assertEqual(
        hydratedSessionId,
        "chat-remote-history",
        "transferred chat hydration should target the moved session id",
      );
      assertEqual(
        hydrateActivate,
        false,
        "transferred chat hydration should not steal active focus",
      );
      assertEqual(
        hydrateLoadAgentContext,
        false,
        "transferred chat hydration should not switch backend agent context during cross-window drop",
      );
    },
  );

  await runCase(
    "hydrateTransferredTabs hydrates every moved chat session in the background",
    async () => {
      const store = new AppStore();
      const hydratedSessionIds: string[] = [];
      (store.chat as any).hydrateSessionFromBackend = async (
        sessionId: string,
        options?: { activate?: boolean; loadAgentContext?: boolean },
      ) => {
        hydratedSessionIds.push(
          `${sessionId}:${String(options?.activate)}:${String(options?.loadAgentContext)}`,
        );
      };

      store.hydrateTransferredTabs("chat", ["chat-1", "chat-2"]);

      await Promise.resolve();

      assertEqual(
        JSON.stringify(hydratedSessionIds),
        JSON.stringify(["chat-1:false:false", "chat-2:false:false"]),
        "bulk transferred chat hydration should preserve the non-activating background load contract",
      );
    },
  );

  await runCase(
    "main suppress terminal should not hide filesystem owner inventory",
    async () => {
      const store = new AppStore();
      (store as any).suppressedTabIdsByKind = {
        chat: new Set<string>(),
        terminal: new Set<string>(),
        filesystem: new Set<string>(),
      };
      store.terminalTabs = [
        {
          id: "term-a",
          title: "Local A",
          config: {
            type: "local",
            id: "term-a",
            title: "Local A",
            cols: 80,
            rows: 24,
          },
          connectionRef: { type: "local" },
          runtimeState: "ready",
        },
      ];
      store.terminalTabsHydrated = true;
      (store.layout as any).syncPanelBindings = () => {};

      store.suppressTabs("terminal", ["term-a"]);
      assertEqual(
        JSON.stringify(store.getOwnedTabIds("terminal")),
        JSON.stringify([]),
        "terminal suppression should hide terminal owner tab",
      );
      assertEqual(
        JSON.stringify(store.getOwnedTabIds("filesystem")),
        JSON.stringify(["term-a"]),
        "terminal suppression should not hide filesystem owner tab",
      );
    },
  );

  await runCase(
    "collectAssignedTabsByKind reflects live layout bindings after detach",
    async () => {
      const store = new AppStore();
      (store.layout as any).tree = {
        schemaVersion: 2,
        root: {
          type: "split",
          id: "root",
          direction: "horizontal",
          children: [
            {
              type: "panel",
              id: "node-chat",
              panel: { id: "panel-chat", kind: "chat" },
            },
            {
              type: "panel",
              id: "node-terminal",
              panel: { id: "panel-terminal", kind: "terminal" },
            },
          ],
          sizes: [50, 50],
        },
        focusedPanelId: "panel-terminal",
        panelTabs: {
          "panel-chat": {
            tabIds: ["chat-a"],
            activeTabId: "chat-a",
          },
          "panel-terminal": {
            tabIds: ["term-a", "term-b"],
            activeTabId: "term-a",
          },
        },
      } as LayoutTree;

      assertEqual(
        JSON.stringify(store.collectAssignedTabsByKind()),
        JSON.stringify({
          chat: ["chat-a"],
          terminal: ["term-a", "term-b"],
          filesystem: [],
        }),
        "assigned tabs should include currently bound ids",
      );

      store.layout.detachTabFromLayout("terminal", "term-a");
      assertEqual(
        JSON.stringify(store.collectAssignedTabsByKind()),
        JSON.stringify({
          chat: ["chat-a"],
          terminal: ["term-b"],
          filesystem: [],
        }),
        "detached tab should not remain in detached-closing payload inventory",
      );
    },
  );

  await runCase(
    "setWsGatewayCustomCidrs commits custom mode only after a non-empty draft",
    async () => {
      const calls: Array<{
        access: string;
        port: number;
        allowedCidrs?: string[];
      }> = [];
      (globalThis as unknown as { window: unknown }).window = {
        gyshell: {
          settings: {
            set: async () => {},
            setWsGatewayConfig: async (ws: {
              access: string;
              port: number;
              allowedCidrs?: string[];
            }) => {
              calls.push(ws);
              return ws;
            },
          },
        },
      };

      const store = new AppStore();
      (store as any).settings = {
        gateway: {
          ws: {
            access: "localhost",
            port: 17888,
            allowedCidrs: [],
          },
        },
      };

      const emptyApplied = await store.setWsGatewayCustomCidrs(" \n ");
      assertEqual(
        emptyApplied,
        false,
        "empty custom draft should not be applied",
      );
      assertEqual(
        calls.length,
        0,
        "empty custom draft should not call the IPC setter",
      );

      const applied = await store.setWsGatewayCustomCidrs(
        "192.168.1.0/24\n10.0.0.0/8",
      );
      assertEqual(applied, true, "non-empty custom draft should be applied");
      assertEqual(
        calls.length,
        1,
        "non-empty custom draft should call the IPC setter once",
      );
      assertEqual(
        calls[0].access,
        "custom",
        "custom draft should switch gateway access mode",
      );
      assertEqual(
        JSON.stringify(calls[0].allowedCidrs),
        JSON.stringify(["192.168.1.0/24", "10.0.0.0/8"]),
        "custom draft should preserve parsed CIDR entries",
      );
    },
  );

  await runCase(
    "setWsGatewayCidrs refuses to clear an active custom filter",
    async () => {
      const calls: Array<{
        access: string;
        port: number;
        allowedCidrs?: string[];
      }> = [];
      (globalThis as unknown as { window: unknown }).window = {
        gyshell: {
          settings: {
            set: async () => {},
            setWsGatewayConfig: async (ws: {
              access: string;
              port: number;
              allowedCidrs?: string[];
            }) => {
              calls.push(ws);
              return ws;
            },
          },
        },
      };

      const store = new AppStore();
      (store as any).settings = {
        gateway: {
          ws: {
            access: "custom",
            port: 17888,
            allowedCidrs: ["192.168.1.0/24"],
          },
        },
      };

      const applied = await store.setWsGatewayCidrs("   ");
      assertEqual(
        applied,
        false,
        "clearing the active custom filter should be rejected",
      );
      assertEqual(
        calls.length,
        0,
        "rejected custom CIDR clear should not call the IPC setter",
      );
    },
  );
};

void run()
  .then(() => {
    console.log("All AppStore extreme tests passed.");
  })
  .catch((error) => {
    console.error(error);
    throw error;
  });
