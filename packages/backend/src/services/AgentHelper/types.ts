import type { TerminalService } from '../TerminalService'
import type { CommandPolicyMode } from '../CommandPolicy/CommandPolicyService'
import type { ICommandPolicyRuntime } from '../runtimeContracts'
import type {
  QueuedAgentInsertionInput,
  RunBackgroundExecCommandInput
} from './queuedInsertions'

export interface ToolExecutionContext {
  sessionId: string
  messageId: string
  terminalService: TerminalService
  sendEvent: (sessionId: string, event: any) => void
  waitForFeedback?: (messageId: string, timeoutMs?: number) => Promise<any | null>
  commandPolicyService: ICommandPolicyRuntime
  commandPolicyMode: CommandPolicyMode
  agentRunId?: string
  enqueueQueuedInsertion?: (insertion: QueuedAgentInsertionInput) => void
  registerBackgroundExecCommand?: (command: RunBackgroundExecCommandInput) => void
  completeBackgroundExecCommand?: (command: RunBackgroundExecCommandInput & { exitCode?: number }) => void
  signal?: AbortSignal
}

export type ReadFileSupport = {
  image: boolean
}
