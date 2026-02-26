export type MobileLocale = "en" | "zh-CN";

export interface MobileTranslations {
  appName: string;
  tabs: {
    chat: string;
    terminal: string;
    skills: string;
    tools: string;
    settings: string;
    navLabel: string;
  };
  topBar: {
    backToSessions: string;
    sessions: string;
    sessionLabel: (id: string) => string;
    noActiveSession: string;
  };
  app: {
    chats: string;
    rollingBack: string;
    rollback: string;
    rollbackConfirmTitle: string;
    rollbackConfirmMessage: string;
    noSession: string;
    untitled: string;
  };
  common: {
    connect: string;
    connecting: string;
    disconnect: string;
    cancel: string;
    details: string;
    allow: string;
    deny: string;
    decision: (value: string) => string;
    streaming: string;
    on: string;
    off: string;
    tool: string;
    expand: string;
    collapse: string;
    notConnected: string;
  };
  composer: {
    placeholder: string;
    stopRun: string;
    send: string;
    sendMessage: string;
    attachImage: string;
    removeImage: string;
    clearImages: string;
    mentionSkill: string;
    mentionTerminal: string;
  };
  sessionBrowser: {
    searchPlaceholder: string;
    createChat: string;
    deleteChat: (title: string) => string;
    deleteConfirm: (title: string) => string;
    empty: string;
    noUpdates: string;
  };
  messageList: {
    rollbackAndEdit: string;
    rollback: string;
    emptyTitle: string;
    emptyHint: string;
  };
  detail: {
    closeDetail: string;
    title: string;
    events: (count: number) => string;
    empty: string;
    assistantText: string;
    systemText: string;
  };
  settings: {
    title: string;
    gateway: string;
    memory: string;
    language: string;
    languageHint: string;
    gatewayHint: string;
    gatewayPlaceholder: string;
    tokenPlaceholder: string;
    memoryHint: string;
    memoryEnabled: string;
    memoryDisabled: string;
    memoryReload: string;
    memoryPathLabel: string;
    memoryContentLabel: string;
    memoryReadOnlyHint: string;
    english: string;
    chinese: string;
  };
  skills: {
    enabledCount: (enabled: number, total: number) => string;
    empty: string;
    noDescription: string;
    reload: string;
    groups: {
      codex: string;
      agents: string;
      claude: string;
      custom: string;
      other: string;
    };
  };
  tools: {
    summary: (
      mcpEnabled: number,
      mcpTotal: number,
      builtInEnabled: number,
      builtInTotal: number,
    ) => string;
    mcpServers: string;
    builtInTools: string;
    mcpEmpty: string;
    builtInEmpty: string;
    noDescription: string;
    status: {
      connected: string;
      connecting: string;
      error: string;
      disabled: string;
    };
    toolCount: (count: number) => string;
    reload: string;
  };
  terminal: {
    localTerminal: string;
    selectTerminalType: string;
    noSavedSsh: string;
    noActiveTerminals: string;
    state: (value: string) => string;
    close: (title: string) => string;
    newTerminal: string;
  };
  format: {
    justNow: string;
    minutesAgo: (n: number) => string;
    hoursAgo: (n: number) => string;
    daysAgo: (n: number) => string;
    commandRun: string;
    toolCall: string;
    fileCreated: string;
    fileEdited: string;
    subTool: string;
    reasoning: string;
    compaction: string;
    alert: string;
    error: string;
    permissionRequired: string;
    message: string;
    unknownFile: string;
    moreLines: (n: number) => string;
    moreChars: (n: number) => string;
  };
}
