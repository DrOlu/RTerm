import type { TerminalService } from '../TerminalService'
import type { FileTransferService } from '../FileTransferService'
import type { CommandPolicyMode } from '../CommandPolicy/CommandPolicyService'
import type { ICommandPolicyRuntime } from '../runtimeContracts'
import type { SSHConnectionEntry, ProxyEntry, TunnelEntry } from '../../types'
import type {
  QueuedAgentInsertionInput,
  RunBackgroundExecCommandInput,
  RunBackgroundFileTransferInput
} from './queuedInsertions'

export interface ToolExecutionContext {
  sessionId: string
  messageId: string
  terminalService: TerminalService
  fileTransferService?: FileTransferService
  sendEvent: (sessionId: string, event: any) => void
  waitForFeedback?: (messageId: string, timeoutMs?: number) => Promise<any | null>
  commandPolicyService: ICommandPolicyRuntime
  commandPolicyMode: CommandPolicyMode
  agentRunId?: string
  /**
   * Saved SSH connections from backend settings (`connections.ssh`).
   * Available to terminal tools that need to spin up a new terminal tab
   * from a saved connection (e.g. open_terminal_tab). The UI holds the
   * canonical list; this snapshot is refreshed every time settings change
   * via AgentService_v2.updateSettings → createExecutionContext.
   */
  savedSshConnections?: readonly SSHConnectionEntry[]
  /** Saved proxies/tunnels from backend settings, used to resolve a saved
   * SSH connection's `proxyId` / `tunnelIds` when materialising a live
   * TerminalConfig (mirrors the UI's AppStore.toTerminalConfig wiring). */
  savedProxies?: readonly ProxyEntry[]
  savedTunnels?: readonly TunnelEntry[]
  enqueueQueuedInsertion?: (insertion: QueuedAgentInsertionInput) => void
  waitForQueuedInsertion?: (signal?: AbortSignal) => Promise<boolean>
  markWaitInterruptedByQueuedInsertion?: () => void
  registerBackgroundExecCommand?: (command: RunBackgroundExecCommandInput) => void
  completeBackgroundExecCommand?: (command: RunBackgroundExecCommandInput & { exitCode?: number }) => void
  registerBackgroundFileTransfer?: (transfer: RunBackgroundFileTransferInput) => void
  completeBackgroundFileTransfer?: (transfer: RunBackgroundFileTransferInput & { status?: string; error?: string }) => void
  signal?: AbortSignal
}

export type ReadFileSupport = {
  image: boolean
}
