import type { TerminalService } from '../TerminalService'
import type { CommandPolicyMode } from '../CommandPolicy/CommandPolicyService'
import type { ICommandPolicyRuntime } from '../runtimeContracts'

export interface ToolExecutionContext {
  sessionId: string
  messageId: string
  terminalService: TerminalService
  sendEvent: (sessionId: string, event: any) => void
  waitForFeedback?: (messageId: string, timeoutMs?: number) => Promise<any | null>
  commandPolicyService: ICommandPolicyRuntime
  commandPolicyMode: CommandPolicyMode
  signal?: AbortSignal
}

export type ReadFileSupport = {
  image: boolean
}
