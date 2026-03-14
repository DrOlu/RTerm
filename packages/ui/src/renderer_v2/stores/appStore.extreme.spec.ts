import { AppStore } from "./AppStore";
import { ChatStore } from "./ChatStore";
import type { LayoutTree } from "../layout";
import { WINDOW_CONTEXT, readDetachedWindowState, stashDetachedWindowState } from "../lib/windowing";

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

const createStorage = (state: Map<string, string>) => ({
  getItem(key: string) {
    return state.has(key) ? state.get(key)! : null;
  },
  setItem(key: string, value: string) {
    state.set(key, value);
  },
  removeItem(key: string) {
    state.delete(key);
  },
});

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
    getSessionSnapshot?: (sessionId: string) => Promise<any>;
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
        getSessionSnapshot: async (sessionId: string) => {
          if (options?.getSessionSnapshot) {
            return await options.getSessionSnapshot(sessionId);
          }
          return options?.runtimeSnapshotsBySessionId?.[sessionId] || {
            id: sessionId,
            isBusy: false,
            lockedProfileId: null,
          };
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
      monitor: {
        start: async () => ({ ok: true }),
        stop: async () => ({ ok: true }),
        subscribe: async () => ({ ok: true }),
        unsubscribe: async () => ({ ok: true }),
        snapshot: async () => null,
        isMonitoring: async () => ({ monitoring: false }),
        onSnapshot: () => () => {},
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
    "detached bootstrap restores filesystem visibility after terminal hydration",
    async () => {
      const originalWindow = (globalThis as any).window;
      const originalContext = {
        role: WINDOW_CONTEXT.role,
        detachedStateToken: WINDOW_CONTEXT.detachedStateToken,
        sourceClientId: WINDOW_CONTEXT.sourceClientId,
      };
      const localStorageState = new Map<string, string>();
      const sessionStorageState = new Map<string, string>();
      const token = "detached-fs-bootstrap";
      const detachedLayoutTree: LayoutTree = {
        schemaVersion: 2,
        root: {
          type: "panel",
          id: "node-fs",
          panel: { id: "panel-fs", kind: "filesystem" },
        },
        focusedPanelId: "panel-fs",
        panelTabs: {
          "panel-fs": {
            tabIds: ["term-a"],
            activeTabId: "term-a",
          },
        },
      };

      try {
        installBootstrapWindowMock(buildPersistedTree());
        (globalThis as any).window.localStorage = createStorage(localStorageState);
        (globalThis as any).window.sessionStorage =
          createStorage(sessionStorageState);
        stashDetachedWindowState(token, {
          sourceClientId: "win-main",
          layoutTree: detachedLayoutTree,
          createdAt: 123,
        });
        (WINDOW_CONTEXT as any).role = "detached";
        (WINDOW_CONTEXT as any).detachedStateToken = token;
        (WINDOW_CONTEXT as any).sourceClientId = "win-main";

        const store = new AppStore();
        (store.layout as any).bootstrap = () => {};
        (store.layout as any).syncPanelBindings = () => {};
        (store as any).loadTools = async () => {};
        (store as any).loadSkills = async () => {};
        (store as any).loadMemory = async () => {};
        (store as any).loadCommandPolicyLists = async () => {};
        (store as any).loadAccessTokens = async () => {};
        (store as any).loadVersionState = async () => {};
        (store as any).loadMobileWebStatus = async () => {};
        (store as any).checkVersion = async () => {};

        await store.bootstrap();

        assertEqual(
          JSON.stringify(store.getOwnedTabIds("filesystem")),
          JSON.stringify(["term-a"]),
          "detached bootstrap should restore file-capable terminal visibility for filesystem panels",
        );
      } finally {
        (WINDOW_CONTEXT as any).role = originalContext.role;
        (WINDOW_CONTEXT as any).detachedStateToken =
          originalContext.detachedStateToken;
        (WINDOW_CONTEXT as any).sourceClientId =
          originalContext.sourceClientId;
        (globalThis as any).window = originalWindow;
      }
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
    "fileSystemTabs inventory excludes terminal-only connection types",
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
            id: "serial-1",
            title: "Serial",
            type: "serial",
            cols: 80,
            rows: 24,
            runtimeState: "ready",
          },
        ],
      } as any);

      assertEqual(
        JSON.stringify(store.fileSystemTabs.map((tab) => tab.id)),
        JSON.stringify(["local-1"]),
        "filesystem inventory should include only file-capable terminal tabs",
      );
      assertEqual(
        JSON.stringify(store.getOwnedTabIds("filesystem")),
        JSON.stringify(["local-1"]),
        "filesystem owner ids should exclude terminal-only connection types",
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
          capabilities: { supportsFilesystem: true, supportsMonitor: true },
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
          capabilities: { supportsFilesystem: true, supportsMonitor: true },
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
    "detached terminal-only tabs do not mirror into filesystem visibility",
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
          capabilities: { supportsFilesystem: true, supportsMonitor: true },
          connectionRef: { type: "local" },
          runtimeState: "ready",
        },
        {
          id: "term-b",
          title: "Local B",
          config: {
            type: "serial",
            id: "term-b",
            title: "Local B",
            cols: 80,
            rows: 24,
          },
          capabilities: { supportsFilesystem: false },
          connectionRef: { type: "serial", entryId: "serial-entry" },
          runtimeState: "ready",
        },
      ] as any;
      store.terminalTabsHydrated = true;
      let syncCallCount = 0;
      (store.layout as any).syncPanelBindings = () => {
        syncCallCount += 1;
      };

      store.unsuppressTabs("terminal", ["term-b"]);
      assertEqual(
        JSON.stringify(
          Array.from(
            ((store as any).detachedVisibleTabIdsByKind.filesystem as Set<string>).values(),
          ),
        ),
        JSON.stringify(["term-a"]),
        "terminal-only tabs should not be mirrored into detached filesystem visibility",
      );
      assertEqual(syncCallCount, 1, "unsuppress should still trigger a single layout sync");
    },
  );

  await runCase(
    "detached filesystem visibility still restores known file-capable tabs from persisted layout",
    async () => {
      const store = new AppStore();
      (store as any).windowRole = "detached";
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
          capabilities: { supportsFilesystem: true, supportsMonitor: true },
          connectionRef: { type: "local" },
          runtimeState: "ready",
        },
      ];
      const visible = (store as any).collectDetachedVisibleTabIdsByKind({
        schemaVersion: 2,
        root: {
          type: "panel",
          id: "node-fs",
          panel: { id: "panel-fs", kind: "filesystem" },
        },
        panelTabs: {
          "panel-fs": { tabIds: ["term-a"], activeTabId: "term-a" },
        },
      });

      assertEqual(
        JSON.stringify(Array.from(visible.filesystem.values())),
        JSON.stringify(["term-a"]),
        "filesystem panels in detached layouts should preserve file-capable tab visibility",
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
          capabilities: { supportsFilesystem: true, supportsMonitor: true },
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
          capabilities: { supportsFilesystem: true, supportsMonitor: true },
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
    "openChatSessionFromHistory restores a moved chat session to the current window",
    async () => {
      const loadChatSessionCalls: string[] = [];
      installBootstrapWindowMock(buildPersistedTree(), {
        allChatHistory: [
          { id: "chat-a", title: "Chat A" },
          { id: "chat-b", title: "Chat B" },
          { id: "chat-c", title: "Chat C" },
          { id: "chat-remote", title: "Remote Session" },
        ],
        uiMessagesBySessionId: {
          "chat-remote": [
            {
              id: "msg-remote",
              role: "assistant",
              type: "text",
              content: "Recovered remote message",
              timestamp: 1,
            },
          ],
        },
        runtimeSnapshotsBySessionId: {
          "chat-a": {
            id: "chat-a",
            title: "Chat A",
            isBusy: false,
            lockedProfileId: null,
          },
          "chat-b": {
            id: "chat-b",
            title: "Chat B",
            isBusy: false,
            lockedProfileId: null,
          },
          "chat-c": {
            id: "chat-c",
            title: "Chat C",
            isBusy: false,
            lockedProfileId: null,
          },
          "chat-remote": {
            id: "chat-remote",
            title: "Remote Session",
            isBusy: false,
            lockedProfileId: null,
          },
        },
        loadChatSessionCalls,
      });

      const store = new AppStore();
      await store.bootstrap();

      store.suppressTabs("chat", ["chat-remote"]);
      await store.openChatSessionFromHistory("chat-remote");

      assertEqual(
        store.chat.activeSessionId,
        "chat-remote",
        "history reopen should activate the restored session",
      );
      assertCondition(
        store.getOwnedTabIds("chat").includes("chat-remote"),
        "history reopen should unsuppress the moved chat session",
      );
      assertCondition(
        store
          .layout
          .getPanelIdsByKind("chat")
          .some((panelId) =>
            store.layout.getPanelTabIds(panelId).includes("chat-remote"),
          ),
        "history reopen should bind the restored chat session back into a chat panel",
      );
      assertCondition(
        loadChatSessionCalls.includes("chat-remote"),
        "history reopen should restore backend agent context for the selected session",
      );
    },
  );

  await runCase(
    "bootstrap prunes stale chat session ids from persisted layout inventory",
    async () => {
      const orphanLayoutTree: LayoutTree = {
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
        focusedPanelId: "panel-chat",
        panelTabs: {
          "panel-chat": {
            tabIds: ["chat-stale"],
            activeTabId: "chat-stale",
          },
          "panel-terminal": {
            tabIds: ["term-a"],
            activeTabId: "term-a",
          },
        },
      };

      installBootstrapWindowMock(orphanLayoutTree, {
        allChatHistory: [],
        getSessionSnapshot: async (sessionId: string) => {
          if (sessionId === "chat-stale") {
            throw new Error("Session not found: chat-stale");
          }
          return {
            id: sessionId,
            isBusy: false,
            lockedProfileId: null,
          };
        },
      });

      const store = new AppStore();
      await store.bootstrap();

      assertCondition(
        !store.chat.sessions.some((session) => session.id === "chat-stale"),
        "bootstrap should drop stale chat sessions that no longer exist in backend or UI history",
      );
      assertCondition(
        !store
          .layout
          .getPanelIdsByKind("chat")
          .flatMap((panelId) => store.layout.getPanelTabIds(panelId))
          .includes("chat-stale"),
        "layout sync should remove stale chat session ids after bootstrap pruning",
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
          capabilities: { supportsFilesystem: true, supportsMonitor: true },
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
          monitor: [],
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
          monitor: [],
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

  await runCase(
    "reconcileTerminalTabs starts and stops backend monitor sessions from the main window",
    async () => {
      const startCalls: Array<{ terminalId: string; intervalMs?: number }> = [];
      const stopCalls: string[] = [];
      const subscribeCalls: string[] = [];
      const unsubscribeCalls: string[] = [];
      (globalThis as unknown as { window: unknown }).window = {
        gyshell: {
          settings: {
            set: async () => {},
          },
          monitor: {
            start: async (terminalId: string, intervalMs?: number) => {
              startCalls.push({ terminalId, intervalMs });
              return { ok: true };
            },
            stop: async (terminalId: string) => {
              stopCalls.push(terminalId);
              return { ok: true };
            },
            subscribe: async (terminalId: string) => {
              subscribeCalls.push(terminalId);
              return { ok: true };
            },
            unsubscribe: async (terminalId: string) => {
              unsubscribeCalls.push(terminalId);
              return { ok: true };
            },
            onSnapshot: () => () => {},
          },
        },
      };

      const store = new AppStore();
      (store as any).isBootstrapped = true;
      (store.layout as any).syncPanelBindings = () => {};

      store.reconcileTerminalTabs({
        terminals: [
          {
            id: "term-a",
            title: "Linux A",
            type: "local",
            cols: 80,
            rows: 24,
            runtimeState: "ready",
          },
          {
            id: "term-b",
            title: "SSH B",
            type: "ssh",
            cols: 80,
            rows: 24,
            runtimeState: "initializing",
          },
        ],
      } as any);
      await Promise.resolve();

      assertEqual(
        JSON.stringify(startCalls),
        JSON.stringify([{ terminalId: "term-a", intervalMs: 3500 }]),
        "ready monitor-capable terminals should start monitor sessions with the shared interval",
      );
      assertEqual(
        JSON.stringify(subscribeCalls),
        JSON.stringify(["term-a", "term-b"]),
        "main window should subscribe only its monitor-capable terminal ids for snapshot delivery",
      );

      store.reconcileTerminalTabs({
        terminals: [
          {
            id: "term-a",
            title: "Linux A",
            type: "local",
            cols: 80,
            rows: 24,
            runtimeState: "exited",
          },
        ],
      } as any);
      await Promise.resolve();

      assertEqual(
        JSON.stringify(stopCalls),
        JSON.stringify(["term-a"]),
        "monitor sessions should stop when the terminal is no longer ready",
      );
      assertEqual(
        JSON.stringify(unsubscribeCalls),
        JSON.stringify(["term-b"]),
        "removed terminals should be unsubscribed from per-window monitor snapshots",
      );
    },
  );

  await runCase(
    "applyMonitorSnapshot ignores terminals that the current window is not subscribed to",
    async () => {
      const store = new AppStore();
      (store as any).monitorSubscribedTabIds = new Set(["term-a"]);

      (store as any).applyMonitorSnapshot({
        terminalId: "term-b",
        timestamp: 1,
        cpu: { usagePercent: 90 },
      });
      (store as any).applyMonitorSnapshot({
        terminalId: "term-a",
        timestamp: 2,
        cpu: { usagePercent: 30 },
      });

      assertCondition(
        store.getMonitorTerminalState("term-b") === null,
        "unsubscribed monitor snapshots should not allocate window-local state",
      );
      assertEqual(
        store.getMonitorTerminalState("term-a")?.snapshot?.cpu?.usagePercent,
        30,
        "subscribed monitor snapshots should still populate window-local state",
      );
    },
  );

  await runCase(
    "applyMonitorSnapshot keeps bounded histories per terminal",
    async () => {
      const store = new AppStore();
      (store as any).monitorSubscribedTabIds = new Set(["term-a"]);
      for (let index = 0; index < 80; index += 1) {
        (store as any).applyMonitorSnapshot({
          terminalId: "term-a",
          timestamp: index,
          cpu: { usagePercent: index },
          memory: { usagePercent: index, totalBytes: 100, usedBytes: 50, availableBytes: 50 },
          network: [{ interface: "eth0", rxBytesPerSec: index * 10, txBytesPerSec: index * 5 }],
        });
      }

      const state = store.getMonitorTerminalState("term-a");
      assertCondition(state !== null, "monitor state should exist after applying snapshots");
      assertEqual(state!.cpuHistory.length, 64, "cpu history should be bounded");
      assertEqual(state!.memoryHistory.length, 64, "memory history should be bounded");
      assertEqual(state!.rxHistory.length, 64, "rx history should be bounded");
      assertEqual(state!.txHistory.length, 64, "tx history should be bounded");
      assertEqual(state!.cpuHistory[0], 16, "history should retain the most recent values");
      assertEqual(state!.cpuHistory[63], 79, "history tail should match the latest snapshot");
    },
  );

  await runCase(
    "setPanelTabDisplayMode updates local settings and persists through uiSettings IPC",
    async () => {
      const originalWindow = (globalThis as any).window;
      const uiSettingsSetCalls: any[] = [];

      try {
        (globalThis as any).window = {
          gyshell: {
            uiSettings: {
              set: async (payload: any) => {
                uiSettingsSetCalls.push(payload);
              },
            },
          },
        };

        const store = new AppStore();
        (store as any).settings = {
          panelTabs: {
            displayMode: "auto",
          },
        };

        await store.setPanelTabDisplayMode("select");

        assertEqual(
          store.panelTabDisplayMode,
          "select",
          "panel tab display mode getter should reflect the latest UI preference",
        );
        assertEqual(
          JSON.stringify(uiSettingsSetCalls),
          JSON.stringify([
            {
              panelTabs: {
                displayMode: "select",
              },
            },
          ]),
          "panel tab display mode should persist through the uiSettings IPC channel",
        );
      } finally {
        (globalThis as any).window = originalWindow;
      }
    },
  );

  await runCase(
    "openDetachedFileEditorForPath stashes a loading editor snapshot for the new window",
    async () => {
      const originalWindow = (globalThis as any).window;
      const localStorageState = new Map<string, string>();
      const sessionStorageState = new Map<string, string>();
      const openDetachedCalls: Array<{ token: string; sourceClientId: string }> = [];

      try {
        (globalThis as any).window = {
          localStorage: createStorage(localStorageState),
          sessionStorage: createStorage(sessionStorageState),
          gyshell: {
            windowing: {
              openDetached: async (token: string, sourceClientId: string) => {
                openDetachedCalls.push({ token, sourceClientId });
                return { ok: true };
              },
            },
          },
        };

        const store = new AppStore();
        const opened = await store.openDetachedFileEditorForPath("term-a", "/tmp/demo.txt");

        assertEqual(opened, true, "detached file editor open should succeed when IPC open succeeds");
        assertEqual(openDetachedCalls.length, 1, "detached file editor should request exactly one window");
        assertEqual(
          openDetachedCalls[0].sourceClientId,
          store.windowClientId,
          "detached file editor should forward the current renderer client id",
        );

        const detachedState = readDetachedWindowState(openDetachedCalls[0].token);
        assertCondition(detachedState !== null, "detached file editor should stash a detached window state");
        assertEqual(
          detachedState!.sourceClientId,
          store.windowClientId,
          "detached file editor state should preserve the source client id",
        );
        assertCondition(detachedState!.layoutTree.root.type === "panel", "detached file editor should use a single-panel layout");
        if (detachedState!.layoutTree.root.type !== "panel") {
          throw new Error("detached file editor layout root should be a panel");
        }
        assertEqual(
          detachedState!.layoutTree.root.panel.kind,
          "fileEditor",
          "detached file editor layout should target the fileEditor panel kind",
        );
        assertEqual(
          JSON.stringify(detachedState!.fileEditorSnapshot),
          JSON.stringify({
            terminalId: "term-a",
            filePath: "/tmp/demo.txt",
            mode: "loading",
            content: "",
            dirty: false,
            errorMessage: null,
            statusMessage: null,
          }),
          "detached file editor should seed the loading snapshot for the requested path",
        );
      } finally {
        (globalThis as any).window = originalWindow;
      }
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
