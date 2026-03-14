import type { StructuredTool } from '@langchain/core/tools'
import type { AgentEvent, BackendSettings, ChatSession, TerminalTab } from '../types'
import type { CommandPolicyListName, CommandPolicyLists, CommandPolicyMode } from './CommandPolicy/CommandPolicyService'
import type { SkillInfo, CreateSkillResult } from './SkillService'
import type { McpServerSummary } from './McpToolService'
import type { MemorySnapshot } from '../memory/FileMemoryStore'
import type { StartTaskInput } from './Gateway/types'
import type { StoredChatSession } from './ChatHistoryService'

export interface ISettingsRuntime {
  getSettings(): BackendSettings
  setSettings(settings: Partial<BackendSettings>): void
}

export interface IChatHistoryRuntime {
  saveSession(session: ChatSession): void
  loadSession(sessionId: string): ChatSession | null
  getAllSessions(): StoredChatSession[]
  deleteSession(sessionId: string): void
  renameSession(sessionId: string, newTitle: string): void
  exportSession(sessionId: string): StoredChatSession | null
}

export interface ICommandPolicyRuntime {
  setFeedbackWaiter(waiter: (messageId: string, timeoutMs?: number) => Promise<any | null>): void
  getPolicyFilePath(): string
  getLists(): Promise<CommandPolicyLists>
  addRule(listName: CommandPolicyListName, rule: string): Promise<CommandPolicyLists>
  deleteRule(listName: CommandPolicyListName, rule: string): Promise<CommandPolicyLists>
  evaluate(command: string, mode: CommandPolicyMode): Promise<'allow' | 'deny' | 'ask'>
  requestApproval(params: {
    sessionId: string
    messageId: string
    command: string
    toolName: string
    sendEvent: (sessionId: string, event: any) => void
    signal?: AbortSignal
  }): Promise<boolean>
  openPolicyFile?(): Promise<void>
}

export interface ISkillRuntime {
  reload(): Promise<SkillInfo[]>
  getAll(): Promise<SkillInfo[]>
  getEnabledSkills(): Promise<SkillInfo[]>
  readSkillContentByName(name: string): Promise<{ info: SkillInfo; content: string }>
  createSkill(name: string, description: string, content: string): Promise<CreateSkillResult>
  createSkillFromTemplate?(): Promise<SkillInfo>
  openSkillsFolder?(): Promise<void>
  openSkillFile?(fileName: string): Promise<void>
  deleteSkillFile?(fileName: string): Promise<void>
}

export interface IMcpRuntime {
  on(event: 'updated', listener: (summary: McpServerSummary[]) => void): this
  getConfigPath(): string
  reloadAll(): Promise<McpServerSummary[]>
  getSummaries(): McpServerSummary[]
  setServerEnabled(name: string, enabled: boolean): Promise<McpServerSummary[]>
  isMcpToolName(toolName: string): boolean
  getActiveTools(): StructuredTool[]
  invokeTool(toolName: string, args: unknown, signal?: AbortSignal): Promise<unknown>
  openConfigFile?(): Promise<void>
}

export interface IMemoryRuntime {
  ensureMemoryFile(): Promise<string>
  getMemoryFilePath(): Promise<string>
  getMemorySnapshot(): Promise<MemorySnapshot>
  readMemory(): Promise<string>
  writeMemory(content: string): Promise<MemorySnapshot>
}

export interface IGatewayTerminalRuntime {
  setRawEventPublisher(publisher: (channel: string, data: unknown) => void): void
  getAllTerminals(): TerminalTab[]
}

export interface IAgentRuntime {
  setEventPublisher(publisher: (sessionId: string, event: AgentEvent) => void): void
  setFeedbackWaiter(waiter: (messageId: string, timeoutMs?: number) => Promise<any | null>): void
  run(context: any, input: StartTaskInput, signal: AbortSignal, startMode?: 'normal' | 'inserted'): Promise<void>
  isAbortError(error: unknown): boolean
  releaseSessionModelBinding(sessionId: string): void
  listStoredChatSessions(): StoredChatSession[]
  loadChatSession(sessionId: string): ChatSession | null
  deleteChatSession(sessionId: string): void
  renameChatSession(sessionId: string, newTitle: string): void
  exportChatSession(sessionId: string): StoredChatSession | null
  rollbackToMessage(sessionId: string, messageId: string): { ok: boolean; removedCount: number }
}
