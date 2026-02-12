import type { StructuredTool } from '@langchain/core/tools'
import type { BackendSettings } from '../types'
import type { CommandPolicyListName, CommandPolicyLists, CommandPolicyMode } from './CommandPolicy/CommandPolicyService'
import type { SkillInfo, CreateOrRewriteSkillResult } from './SkillService'
import type { McpServerSummary } from './McpToolService'

export interface ISettingsRuntime {
  getSettings(): BackendSettings
  setSettings(settings: Partial<BackendSettings>): void
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
  createOrRewriteSkill(name: string, description: string, content: string): Promise<CreateOrRewriteSkillResult>
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
