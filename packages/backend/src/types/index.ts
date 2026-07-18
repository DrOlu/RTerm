import type { TerminalConnectionCapabilities } from '@gyshell/shared'

// ============ Settings Types ============
export interface ModelDefinition {
  /** Stable id used by profiles */
  id: string
  /** Display name */
  name: string
  /** Provider model name, e.g. "gpt-4o" */
  model: string
  /** Optional override for API Key */
  apiKey?: string
  /** Optional override for Base URL */
  baseUrl?: string
  /** Max tokens for context management */
  maxTokens: number
  /** Structured output mode: auto probe or manual override */
  structuredOutputMode?: 'auto' | 'on' | 'off'
  /** Whether this model supports OpenAI JSON Schema structured output */
  supportsStructuredOutput: boolean
  /** Whether this model accepts object-style tool_choice payloads */
  supportsObjectToolChoice: boolean
  /** Cached capability profile detected by backend */
  profile?: {
    imageInputs?: boolean
    textOutputs?: boolean
    testedAt?: number
    ok?: boolean
    error?: string
  }
}

export interface ModelProfile {
  id: string
  name: string
  /**
   * Current app only uses one model (global).
   * We keep this structure to support multi-model agents in the future.
   */
  globalModelId: string
  // reserved for future:
  actionModelId?: string
  thinkingModelId?: string
  compactionModelId?: string
}

export interface ExperimentalFlags {
  runtimeThinkingCorrectionEnabled: boolean
  taskFinishGuardEnabled: boolean
  firstTurnThinkingModelEnabled: boolean
  execCommandActionModelEnabled: boolean
  writeStdinActionModelEnabled: boolean
}

export type CommandPolicyMode = 'safe' | 'standard' | 'smart'

export type AgentSettingSlotNumber = 1 | 2 | 3 | 4 | 5

export interface AgentSettingCommandPolicyLists {
  allowlist: string[]
  denylist: string[]
  asklist: string[]
}

export interface AgentSettingSnapshot {
  version: 1
  security: {
    commandPolicyMode: CommandPolicyMode
    commandPolicyLists: AgentSettingCommandPolicyLists
  }
  tools: {
    builtIn: Record<string, boolean>
    mcp: Record<string, boolean>
  }
  skills: Record<string, boolean>
  memory: {
    enabled: boolean
  }
  workflow: {
    recursionLimit: number
    experimental: ExperimentalFlags
  }
  model: {
    activeProfileId: string
    activeProfileName?: string
  }
}

export interface AgentSettingProfile {
  id: string
  slotNumber: AgentSettingSlotNumber
  createdAt: number
  updatedAt: number
  snapshot: AgentSettingSnapshot
}

export interface AgentSettingState {
  profiles: AgentSettingProfile[]
  activeProfileId: string | null
}

export interface SSHConnectionEntry {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: 'password' | 'privateKey'
  // Credentials stored locally (future: keychain integration)
  password?: string
  privateKey?: string
  privateKeyPath?: string
  passphrase?: string
  // optional proxy/tunnel refs (future)
  proxyId?: string
  tunnelIds?: string[]
  /** Optional jump host configuration for this SSH connection */
  jumpHost?: SSHConnectionEntry
  /**
   * SSH algorithm/key-exchange preset. `legacy`/`cisco` broaden the
   * negotiated algorithms for devices (e.g. older Cisco IOS) that only
   * support diffie-hellman-group1-sha1, ssh-rsa, aes*-cbc, hmac-sha1.
   * `modern` (default) keeps ssh2's strict defaults.
   */
  algorithmsPreset?: 'modern' | 'legacy' | 'cisco'
  /** TERM value requested for the remote shell/PTY (e.g. `vt100` for some network equipment). */
  termType?: string
  /** Optional group/folder id this connection belongs to (see automation.groups). */
  groupId?: string
  /** Free-form operator notes for this connection (per-device knowledge). */
  notes?: string
}

/** Saved serial console connection entry. */
export interface SerialConnectionEntry {
  id: string
  name: string
  /** OS path to the serial device, e.g. /dev/ttyUSB0 or COM3. */
  path: string
  baudRate: number
  dataBits?: 5 | 6 | 7 | 8
  parity?: 'none' | 'even' | 'odd'
  stopBits?: 1 | 2
  flowControl?: 'none' | 'xon/xoff' | 'rts/cts'
  groupId?: string
  notes?: string
}

/** Saved WinRM connection entry (Connections panel / manage_winrm_connection).
 * Mirrors WinRMConnectionConfig minus runtime-only fields (id/title/cols/rows). */
export interface WinRMConnectionEntry {
  id: string
  name: string
  host: string
  port: number
  username: string
  password: string
  transport?: 'http' | 'https'
  auth?: 'basic' | 'negotiate'
  domain?: string
  rejectUnauthorized?: boolean
  /** Optional group/folder id this connection belongs to (see automation.groups). */
  groupId?: string
  /** Free-form operator notes for this connection. */
  notes?: string
}

// ============ Automation Types (Netcatty/NetStacks parity, local-only) ============

/** A folder/group of saved connections (ssh + winrm). Tree via parentId. */
export interface GroupEntry {
  id: string
  name: string
  /** Parent group id; undefined/null = top-level. */
  parentId?: string | null
  /** Optional color/icon hint for the UI. */
  color?: string
  notes?: string
}

/** A per-device memory record (local only — no server sharing). Keyed by host. */
export interface DeviceMemoryEntry {
  /** The host (or host:port) this memory belongs to. */
  host: string
  /** Operator role/criticality label. */
  role?: string
  /** Standing instructions (always injected into agent context for this host). */
  standingInstructions?: string
  /** Dated incident/repair history. */
  incidents: DeviceIncident[]
}

export interface DeviceIncident {
  /** ISO timestamp. */
  at: string
  /** Short summary, e.g. "BGP peer flapping". */
  summary: string
  /** Root cause / resolution notes. */
  resolution?: string
  /** Linked ticket id (ServiceNow/Jira), optional. */
  ticketId?: string
}

/** A saved script/snippet runnable on one or more open tabs. */
export interface ScriptEntry {
  id: string
  name: string
  /** The command(s) to run. Multi-line scripts are joined and sent per target. */
  command: string
  /** Optional description. */
  description?: string
  /** Target scope: explicit saved-connection names, or group id, or tag. */
  targets?: string[]
  groupId?: string
  /** Tags for filtering/targeting. */
  tags?: string[]
  /** Creation + last-modified timestamps. */
  createdAt?: string
  updatedAt?: string
}

/** A cron-scheduled task that runs a saved script (or raw command). */
export interface ScheduledTaskEntry {
  id: string
  name: string
  /** Standard 5-field cron expression. */
  cron: string
  /** What to run: a saved script id, or an inline command. */
  scriptId?: string
  command?: string
  /** Target scope: group id, tags, or explicit connection names. */
  groupId?: string
  tags?: string[]
  targets?: string[]
  /** Retry config. */
  retryAttempts?: number
  retryDelaySeconds?: number
  enabled: boolean
  /** ISO timestamp of last run, for the UI. */
  lastRunAt?: string
}

/** A versioned, parameterized configuration template (Jinja-subset render). */
export interface ConfigTemplateEntry {
  id: string
  name: string
  /** Jinja-subset body: {{ var }}, {% for %}, {% if %}, filters (default,upper,lower). */
  body: string
  /** Declared variables (name + optional default) for the render form. */
  variables: ConfigTemplateVariable[]
  /** Ordered list of saved rendered versions (newest last) for diff/rollback. */
  versions: ConfigTemplateVersion[]
  updatedAt?: string
}

export interface ConfigTemplateVariable {
  name: string
  defaultValue?: string
  description?: string
}

export interface ConfigTemplateVersion {
  /** ISO timestamp. */
  at: string
  /** Rendered output. */
  rendered: string
  /** Variables used for this render (snapshot). */
  variables: Record<string, unknown>
}

export interface AutomationSettings {
  groups: GroupEntry[]
  deviceMemory: DeviceMemoryEntry[]
  scripts: ScriptEntry[]
  scheduledTasks: ScheduledTaskEntry[]
  templates: ConfigTemplateEntry[]
  playbooks: PlaybookEntry[]
}

/** One step in a playbook — run sequentially on every resolved target. */
/**
 * Post-step validation: after a command/script step succeeds, run a check
 * command (inline or saved script) whose output must match `expect`.
 * A mismatch fails the step (triggering the playbook failure policy and,
 * when rollbacks are defined, the automatic undo sequence).
 */
export interface PlaybookStepValidation {
  /** Inline check command (mutually exclusive with scriptId). */
  command?: string
  /** Saved script id used as the check (mutually exclusive with command). */
  scriptId?: string
  /** Pattern the check output must contain/match. */
  expect: string
  /** How `expect` is interpreted (default substring). */
  expectMode?: 'substring' | 'regex'
}

/** Undo action for a step. Executed in reverse step order when a later
 * step (or its validation) fails, and first for the failed step itself. */
export interface PlaybookStepRollback {
  kind: 'command' | 'script'
  /** Inline undo command (kind=command). */
  command?: string
  /** Saved script id (kind=script). */
  scriptId?: string
}

export interface PlaybookStep {
  id: string
  /** Optional display name (e.g. "backup config"). */
  name?: string
  /**
   * Step kind:
   * - command: run an inline command
   * - script: run a saved script by id
   * - wait: pause for waitSeconds before the next step
   */
  kind: 'command' | 'script' | 'wait'
  /** Inline command (kind=command). */
  command?: string
  /** Saved script id (kind=script). */
  scriptId?: string
  /** Seconds to pause (kind=wait). */
  waitSeconds?: number
  /** Per-step failure policy; overrides the playbook-level onError. */
  onError?: 'stop' | 'continue'
  /** Optional post-step validation (command/script steps only). */
  validate?: PlaybookStepValidation
  /** Optional undo action for the automatic rollback sequence. */
  rollback?: PlaybookStepRollback
}

/**
 * A playbook — an ordered, multi-step workflow (command/script/wait steps)
 * that runs against a target scope (group, tags, or explicit connections;
 * empty scope = local shell). Steps run sequentially per target; targets are
 * executed one at a time so shared infrastructure is never hammered in
 * parallel by accident.
 */
export interface PlaybookEntry {
  id: string
  name: string
  description?: string
  steps: PlaybookStep[]
  /** Target scope (same semantics as ScriptEntry/ScheduledTaskEntry). */
  groupId?: string
  tags?: string[]
  targets?: string[]
  /** Default failure policy for steps that don't override it (default stop). */
  onError?: 'stop' | 'continue'
  /**
   * MOP mode: when true, this playbook may only run through an approved
   * change record (manage_change plan → approve → run). Plain run_playbook
   * calls are refused.
   */
  requireApproval?: boolean
  createdAt?: string
  updatedAt?: string
  /** ISO timestamp of last run, for the UI. */
  lastRunAt?: string
  /** Outcome of the last run (ok / failed), for the UI. */
  lastRunOk?: boolean
}

export interface ProxyEntry {
  id: string
  name: string
  type: 'socks5' | 'http'
  host: string
  port: number
  username?: string
  password?: string
}

export enum PortForwardType {
  Local = 'Local',
  Remote = 'Remote',
  Dynamic = 'Dynamic',
}

export interface TunnelEntry {
  id: string
  name: string
  /** Type of port forwarding */
  type: PortForwardType
  /** Listen address on the forwarding side */
  host: string
  /** Listen port on the forwarding side */
  port: number
  /** Target address (not used for dynamic forwarding) */
  targetAddress?: string
  /** Target port (not used for dynamic forwarding) */
  targetPort?: number
  /** Which ssh connection provides the tunnel */
  viaConnectionId?: string
}

export type WsGatewayAccess =
  | 'disabled'
  | 'localhost'
  | 'internet'
  | 'lan'
  | 'custom'

export interface WsGatewaySettings {
  access: WsGatewayAccess
  port: number
  /** Allowed CIDR ranges when access === 'custom'. Comma or newline separated. */
  allowedCidrs?: string[]
}

export interface BackendSettings {
  /** Settings schema version, used for migrations */
  schemaVersion: 4

  /** Command policy mode */
  commandPolicyMode: CommandPolicyMode

  /**
   * Effective model config for current AgentService (legacy + runtime binding).
   * Kept for compatibility with existing code until AgentService supports multi-model profiles.
   */
  model: string
  baseUrl: string
  apiKey: string

  /** Model registry + profile selection */
  models: {
    items: ModelDefinition[]
    profiles: ModelProfile[]
    activeProfileId: string
  }

  /** Saved connections (local is implicit, ssh is persisted) */
  connections: {
    ssh: SSHConnectionEntry[]
    winrm: WinRMConnectionEntry[]
    serial: SerialConnectionEntry[]
    proxies: ProxyEntry[]
    tunnels: TunnelEntry[]
  }

  /** Tools enablement (built-in only; MCP is managed separately) */
  tools: {
    builtIn: Record<string, boolean>
    skills?: Record<string, boolean>
  }

  /** Layout persistence */
  layout?: {
    window?: {
      width: number
      height: number
      x?: number
      y?: number
    }
    panelSizes?: number[]
    panelOrder?: string[] // e.g. ['chat', 'terminal']
    /**
     * Renderer-owned layout tree payload for advanced multi-panel composition.
     * Kept as unknown at backend boundary to avoid coupling renderer internals.
     */
    v2?: unknown
    /**
     * Renderer-owned saved workspace layout slots.
     * Kept as unknown at backend boundary to avoid coupling renderer internals.
     */
    savedLayouts?: unknown
    activeSavedLayoutId?: string | null
  }
  /** Agent recursion limit */
  recursionLimit?: number
  /** Global memory injection control */
  memory?: {
    enabled: boolean
  }
  /** Agent-owned saved setting profiles */
  agentSettings?: AgentSettingState
  /** Debug mode switch for backend debug payload persistence and related diagnostics */
  debugMode?: boolean
  /** Experimental feature switches */
  experimental?: ExperimentalFlags

  /**
   * Automation subsystems (Netcatty/NetStacks-parity features that don't need
   * a server): connection groups, per-device memory, saved scripts/snippets,
   * scheduled tasks, and config templates. All local, single-user.
   */
  automation?: AutomationSettings
  /** Session logging (record terminal output to disk per session). */
  sessionLogging?: { enabled: boolean }

  /** WebSocket gateway exposure policy */
  gateway: {
    ws: WsGatewaySettings
    mobileWeb?: {
      /** Preferred port, null means auto-select */
      port: number | null
    }
  }
}

// ============ Terminal Types ============
export type ConnectionType = string

export interface BaseConnectionConfig {
  type: ConnectionType
  id: string
  /** Display name for UI/agent/system prompts (required, no legacy fallback) */
  title: string
  cols: number
  rows: number
}

export interface LocalConnectionConfig extends BaseConnectionConfig {
  type: 'local'
  cwd?: string
  shell?: string
}

export interface SSHConnectionConfig extends BaseConnectionConfig {
  type: 'ssh'
  host: string
  port: number
  username: string
  authMethod: 'password' | 'privateKey'
  password?: string
  privateKey?: string
  privateKeyPath?: string
  passphrase?: string
  /** Optional proxy configuration for SSH connection */
  proxy?: ProxyEntry
  /** Port forwarding rules to activate for this SSH session */
  tunnels?: TunnelEntry[]
  /** Optional jump host configuration for this SSH connection */
  jumpHost?: SSHConnectionConfig
  /**
   * SSH algorithm/key-exchange preset. The Node `ssh2` library ships with
   * modern, strict defaults (curve25519, rsa-sha2-256/512, aes*-gcm). Many
   * legacy devices — notably older Cisco IOS/IOS-XE routers and switches —
   * only offer legacy algorithms (diffie-hellman-group1-sha1, ssh-rsa,
   * aes*-cbc, hmac-sha1), which fail handshake negotiation with the strict
   * defaults. `legacy`/`cisco` broaden the negotiated set for those targets;
   * `modern` (default) leaves ssh2 defaults in place.
   */
  algorithmsPreset?: 'modern' | 'legacy' | 'cisco'
  /**
   * TERM value requested for the remote shell/PTY. Some legacy network
   * equipment expects `vt100` and misbehaves with the default `xterm`.
   * Leave unset to use the harness default.
   */
  termType?: string
}

export interface GenericConnectionConfig extends BaseConnectionConfig {
  [key: string]: unknown
}

/** WinRM (Windows Remote Management) connection — WS-Management over
 * HTTP(5985)/HTTPS(5986). Scoped to command execution + the fleet tools:
 * the backend runs each command as a stateless create-shell→run→receive→
 * delete cycle and renders the tab as a command/response log (no PTY). */
export interface WinRMConnectionConfig extends BaseConnectionConfig {
  type: 'winrm'
  host: string
  port: number
  username: string
  password: string
  /** 'http' (5985) or 'https' (5986). Default derived from port. */
  transport?: 'http' | 'https'
  /** Auth scheme. v1 implements 'basic' (the common lab/non-domain path).
   * 'negotiate'/'kerberos' are accepted for forward-compat but route to the
   * same Basic header today. */
  auth?: 'basic' | 'negotiate'
  /** Optional Active Directory domain (prepended to username as DOMAIN\user). */
  domain?: string
  /** For HTTPS with self-signed certs, set false to skip cert verification. */
  rejectUnauthorized?: boolean
}

export type TerminalConfig =
  | LocalConnectionConfig
  | SSHConnectionConfig
  | WinRMConnectionConfig
  | GenericConnectionConfig

export const isLocalConnectionConfig = (config: {
  type: string
}): config is LocalConnectionConfig => config.type === 'local'

export const isSshConnectionConfig = (config: {
  type: string
}): config is SSHConnectionConfig => config.type === 'ssh'

export const isWinrmConnectionConfig = (config: {
  type: string
}): config is WinRMConnectionConfig => config.type === 'winrm'

export interface TerminalTab {
  id: string
  ptyId: string
  title: string
  cols: number
  rows: number
  type: ConnectionType
  capabilities: TerminalConnectionCapabilities
  isInitializing?: boolean // Silence mode flag
  runtimeState?: 'initializing' | 'ready' | 'exited'
  lastExitCode?: number
  remoteOs?: 'unix' | 'windows'
  systemInfo?: TerminalSystemInfo
}

export interface TerminalSystemInfo {
  os: string // e.g. "darwin", "linux", "win32", "ubuntu", "centos"
  platform: string // e.g. "darwin", "linux", "win32"
  release: string // version
  arch: string
  hostname: string
  isRemote: boolean
  shell?: string
}

export interface CommandResult {
  stdoutDelta: string
  exitCode?: number
  history_command_match_id: string
}

export type TerminalCommandTrackingMode = 'windows-powershell-sidecar'

export interface TerminalCommandTrackingToken {
  mode: TerminalCommandTrackingMode
  baselineSequence: number
  awaitingInitialFreshMarker?: boolean
  dispatchedAtMs?: number
  dispatchMode?: 'prompt-file'
  displayMode?: 'synthetic-transcript'
  commandRequestPath?: string
  commandOutputPath?: string
}

export interface TerminalCommandTrackingUpdate {
  mode: TerminalCommandTrackingMode
  sequence: number
  exitCode?: number
  cwd?: string
  homeDir?: string
  output?: string
}

export interface CommandTask {
  id: string
  command: string
  wireCommand?: string
  completionTracking?: TerminalCommandTrackingToken
  displayMode?: 'synthetic-transcript'
  type: 'wait' | 'nowait'
  status: 'running' | 'finished' | 'aborted' | 'timeout'
  startOffset: number
  endOffset?: number
  exitCode?: number
  output?: string
  lastOutputAtMs?: number
  capturedOutput?: string
  suppressFinishCallback?: boolean
  startTime: number
  endTime?: number
  startAbsLine?: number
}

export interface FileStatInfo {
  exists: boolean
  isDirectory: boolean
  /** File size in bytes. Only present when the file exists and is not a directory. */
  size?: number
}

export interface FileSystemEntry {
  name: string
  path: string
  isDirectory: boolean
  isSymbolicLink: boolean
  size: number
  mode?: string
  modifiedAt?: string
}

export interface FileChunkReadResult {
  chunk: Buffer
  bytesRead: number
  totalSize: number
  nextOffset: number
  eof: boolean
}

export interface FileChunkWriteResult {
  writtenBytes: number
  nextOffset: number
}

// ============ Agent Types ============
export type AgentActionType = 'say' | 'command' | 'done'

export interface AgentAction {
  type: AgentActionType
  content?: string
  command?: string
  summary?: string
}

import { StoredMessage } from '@langchain/core/messages'

export interface ChatSession {
  id: string
  title: string
  messages: Map<string, StoredMessage>
  lastCheckpointOffset: number
  lastProfileMaxTokens?: number
}

export interface InputImageAttachment {
  attachmentId?: string
  fileName?: string
  mimeType?: string
  sizeBytes?: number
  sha256?: string
  previewDataUrl?: string
  status?: 'ready' | 'missing'
}

export interface UserInputPayload {
  text: string
  images?: InputImageAttachment[]
}

// ============ Agent Events (Main → Renderer) ============
export type AgentEventType =
  | 'say'
  | 'remove_message'
  | 'command_started'
  | 'command_finished'
  | 'command_ask'
  | 'tool_call'
  | 'file_edit'
  | 'file_read' // Added
  | 'sub_tool_started'
  | 'sub_tool_delta'
  | 'sub_tool_finished'
  | 'done'
  | 'alert'
  | 'error'
  | 'debug_history'
  | 'user_input'
  | 'compaction_boundary'
  | 'tokens_count'

export interface AgentEvent {
  type: AgentEventType
  messageId?: string
  inputKind?: 'normal' | 'inserted'
  inputImages?: InputImageAttachment[]
  level?: 'info' | 'warning' | 'error'
  content?: string
  command?: string
  commandId?: string
  tabName?: string
  toolName?: string
  approvalId?: string
  title?: string
  hint?: string
  input?: string
  output?: string
  filePath?: string
  action?: 'created' | 'edited' | 'error'
  diff?: string
  exitCode?: number
  outputDelta?: string
  summary?: string
  message?: string
  details?: string
  history?: any[] // Raw LangChain message history
  modelName?: string
  totalTokens?: number
  maxTokens?: number
  boundaryTargetMessageId?: string
  boundaryPreviousMessageId?: string
  summaryMessageId?: string
  protectedNormalRounds?: number
}

// ============ Resource Monitor Types ============
export interface CpuSnapshot {
  /** Overall CPU usage percentage (0–100) */
  usagePercent: number
  /** Per-core usage percentages */
  corePercents?: number[]
  /** Logical CPU/core count */
  logicalCoreCount?: number
  /** CPU model name when available */
  modelName?: string
  /** User time percentage */
  userPercent?: number
  /** System/kernel time percentage */
  systemPercent?: number
  /** Idle time percentage */
  idlePercent?: number
}

export interface MemorySnapshot {
  /** Total memory in bytes */
  totalBytes: number
  /** Used memory in bytes */
  usedBytes: number
  /** Available memory in bytes */
  availableBytes: number
  /** Usage percentage (0–100) */
  usagePercent: number
  /** Free memory bytes when available */
  freeBytes?: number
  /** Cache / reclaimable memory bytes when available */
  cachedBytes?: number
  /** Wired memory bytes when available */
  wiredBytes?: number
  /** Compressed memory bytes when available */
  compressedBytes?: number
  /** Swap usage info */
  swap?: {
    totalBytes: number
    usedBytes: number
  }
}

export interface DiskSnapshot {
  /** Filesystem name / mount point */
  filesystem: string
  mountPoint: string
  /** Total bytes */
  totalBytes: number
  /** Used bytes */
  usedBytes: number
  /** Available bytes */
  availableBytes: number
  /** Usage percentage (0–100) */
  usagePercent: number
}

export interface GpuSnapshot {
  /** GPU name/model */
  name?: string
  /** GPU utilization percentage (0–100) */
  utilizationPercent: number
  /** Memory used in MiB */
  memoryUsedMiB: number
  /** Total memory in MiB */
  memoryTotalMiB: number
  /** Memory usage percentage derived from used/total when available */
  memoryUsagePercent?: number
  /** GPU memory-controller utilization percentage (0–100) when available */
  memoryUtilizationPercent?: number
  /** Shared/system memory currently used by the GPU in MiB when available */
  sharedMemoryUsedMiB?: number
  /** GPU temperature in Celsius */
  temperatureC?: number
  /** Current board power draw in watts when available */
  powerUsageWatts?: number
  /** Board power cap or rated power in watts when available */
  powerLimitWatts?: number
  /** Vendor-reported power/performance state when available */
  powerState?: string
  /** Memory clock in MHz when available */
  memoryClockMHz?: number
}

export interface NetworkSnapshot {
  /** Network interface name */
  interface: string
  /** Bytes received since last sample */
  rxBytesPerSec: number
  /** Bytes transmitted since last sample */
  txBytesPerSec: number
}

export interface ProcessSnapshot {
  /** Process ID */
  pid: number
  /** Owning user when available */
  user?: string
  /** Display/process name */
  name: string
  /** CPU usage percentage */
  cpuPercent?: number
  /** Resident/working-set bytes */
  memoryBytes?: number
  /** Full command line when available */
  command?: string
  /** Executable path when available */
  path?: string
  /** Process state when available */
  state?: string
}

export interface NetworkConnectionSnapshot {
  /** Transport protocol */
  protocol: 'tcp' | 'udp'
  /** Listening/bound/local address */
  localAddress: string
  /** Listening/bound/local port */
  localPort?: number
  /** Socket state such as LISTEN / ESTABLISHED */
  state?: string
  /** Whether this row represents a listening socket */
  isListening?: boolean
  /** Owning PID when available */
  pid?: number
  /** Owning process name when available */
  processName?: string
  /** Owning user when available */
  user?: string
  /** Number of unique remote hosts currently attached to this socket */
  remoteHostCount: number
  /** Number of active connections currently attached to this socket */
  connectionCount: number
}

export interface ResourceSystemSnapshot {
  /** Local or SSH-backed connection type */
  connectionType: ConnectionType
  /** Normalized OS/platform */
  platform: 'linux' | 'darwin' | 'windows' | 'unknown'
  /** Reported hostname when available */
  hostname?: string
  /** Friendly OS name / distro */
  osName?: string
  /** OS release / kernel / version */
  release?: string
  /** CPU architecture */
  arch?: string
  /** Default shell */
  shell?: string
}

export interface ResourceSnapshot {
  /** Timestamp when the snapshot was taken (ms since epoch) */
  timestamp: number
  /** Terminal ID this snapshot belongs to */
  terminalId: string
  /** Host/platform metadata */
  system?: ResourceSystemSnapshot
  /** System load averages [1min, 5min, 15min] */
  loadAverage?: [number, number, number]
  /** CPU snapshot */
  cpu?: CpuSnapshot
  /** Memory snapshot */
  memory?: MemorySnapshot
  /** Disk snapshots */
  disks?: DiskSnapshot[]
  /** GPU snapshots (may be empty if no GPU detected) */
  gpus?: GpuSnapshot[]
  /** Network interface snapshots */
  network?: NetworkSnapshot[]
  /** Top processes */
  processes?: ProcessSnapshot[]
  /** Aggregated socket/listener view */
  networkConnections?: NetworkConnectionSnapshot[]
  /** System uptime in seconds */
  uptimeSeconds?: number
  /** Error message if collection partially failed */
  error?: string
}

// ============ Terminal Backend Interface ============
export interface TerminalSessionBackend {
  /**
   * Spawns a connection.
   * @returns The ptyId or session identifier
   */
  spawn(config: TerminalConfig): Promise<string>

  /**
   * Write data to the backend (pty/ssh channel).
   */
  write(ptyId: string, data: string): void

  /**
   * Resize the terminal session.
   */
  resize(ptyId: string, cols: number, rows: number): void

  /**
   * Kill/Disconnect the session.
   */
  kill(ptyId: string): void

  /**
   * Subscribe to data events from the backend.
   */
  onData(ptyId: string, callback: (data: string) => void): void

  /**
   * Subscribe to exit events.
   */
  onExit(ptyId: string, callback: (code: number) => void): void

  /**
   * Get current working directory for the session.
   */
  getCwd(ptyId: string): string | undefined

  /**
   * Get the home directory for the session.
   */
  getHomeDir(ptyId: string): Promise<string | undefined>

  /**
   * Get the remote OS type if known.
   */
  getRemoteOs(ptyId: string): 'unix' | 'windows' | undefined

  /**
   * Get detailed system information.
   */
  getSystemInfo(ptyId: string): Promise<TerminalSystemInfo | undefined>

  /**
   * Execute a side-band command on the session and collect stdout/stderr when supported.
   */
  execOnSession?(
    ptyId: string,
    command: string,
    timeoutMs?: number,
    options?: TerminalExecOptions,
  ): Promise<{ stdout: string; stderr: string } | null>

  /**
   * Direct (non-streaming) command execution for backends that don't expose a
   * real PTY / shell-integration markers — e.g. WinRM's request/response shell
   * model. When present, TerminalService routes exec_command through this path
   * instead of write+marker-tracking. Returns combined stdout/stderr + exit
   * code. The service supplies the history_command_match_id (the taskId).
   */
  executeCommand?(
    ptyId: string,
    command: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>

  /**
   * Capture backend-specific command tracking state before dispatching a command.
   * Backends return undefined when the normal shell integration path remains sufficient.
   */
  prepareCommandTracking?(
    ptyId: string,
  ): Promise<TerminalCommandTrackingToken | undefined>

  /**
   * Poll backend-specific command tracking state after a command has been dispatched.
   * Returns undefined until the tracked command is known to have finished.
   */
  pollCommandTracking?(
    ptyId: string,
    token: TerminalCommandTrackingToken,
  ): Promise<TerminalCommandTrackingUpdate | undefined>

  /**
   * Best-effort runtime state refresh used by path resolution on shells whose cwd/home
   * tracking depends on an out-of-band sidecar channel.
   */
  refreshSessionState?(ptyId: string): Promise<void>
}

export interface TerminalExecOptions {
  /**
   * Optional standard input payload to write to the spawned side-band command.
   */
  stdin?: string
}

export interface TerminalFileSystemBackend {
  /**
   * Read a file from the backend connection.
   */
  readFile(ptyId: string, filePath: string): Promise<Buffer>

  /**
   * Write a file through the backend connection.
   */
  writeFile(ptyId: string, filePath: string, content: string): Promise<void>

  /**
   * Read a partial chunk from file for streaming transfer.
   */
  readFileChunk(
    ptyId: string,
    filePath: string,
    offset: number,
    chunkSize: number,
    options?: { totalSizeHint?: number },
  ): Promise<FileChunkReadResult>

  /**
   * Write a partial chunk to file for streaming transfer.
   */
  writeFileChunk(
    ptyId: string,
    filePath: string,
    offset: number,
    content: Buffer,
    options?: { truncate?: boolean; close?: boolean },
  ): Promise<FileChunkWriteResult>

  /**
   * Optional fast path: backend-side pull from terminal to local file.
   */
  downloadFileToLocalPath?(
    ptyId: string,
    sourcePath: string,
    targetLocalPath: string,
    options?: {
      onProgress?: (progress: {
        bytesTransferred: number
        totalBytes: number
        eof: boolean
      }) => void
      signal?: AbortSignal
    },
  ): Promise<{ totalBytes: number }>

  /**
   * Optional fast path: backend-side push from local file to terminal.
   */
  uploadFileFromLocalPath?(
    ptyId: string,
    sourceLocalPath: string,
    targetPath: string,
    options?: {
      onProgress?: (progress: {
        bytesTransferred: number
        totalBytes: number
        eof: boolean
      }) => void
      signal?: AbortSignal
    },
  ): Promise<{ totalBytes: number }>

  /**
   * Stat a file through the backend connection.
   */
  statFile(ptyId: string, filePath: string): Promise<FileStatInfo>

  /**
   * List directory entries through the backend connection.
   */
  listDirectory(ptyId: string, dirPath: string): Promise<FileSystemEntry[]>

  /**
   * Create a new directory.
   */
  createDirectory(ptyId: string, dirPath: string): Promise<void>

  /**
   * Create an empty file.
   */
  createFile(ptyId: string, filePath: string): Promise<void>

  /**
   * Delete a file or directory.
   */
  deletePath(
    ptyId: string,
    targetPath: string,
    options?: { recursive?: boolean },
  ): Promise<void>

  /**
   * Rename or move a file or directory.
   */
  renamePath(
    ptyId: string,
    sourcePath: string,
    targetPath: string,
  ): Promise<void>

  /**
   * Write file bytes through the backend connection.
   */
  writeFileBytes(
    ptyId: string,
    filePath: string,
    content: Buffer,
  ): Promise<void>

  /**
   * Optional: Hook for custom initialization logic (e.g. SSH injection)
   * This might be internal to the implementation but good to have in mind.
   */
}

export type TerminalBackend = TerminalSessionBackend &
  Partial<TerminalFileSystemBackend>

export const isTerminalFileSystemBackend = (
  backend: TerminalBackend,
): backend is TerminalSessionBackend & TerminalFileSystemBackend =>
  typeof backend.readFile === 'function' &&
  typeof backend.writeFile === 'function' &&
  typeof backend.readFileChunk === 'function' &&
  typeof backend.writeFileChunk === 'function' &&
  typeof backend.statFile === 'function' &&
  typeof backend.listDirectory === 'function' &&
  typeof backend.createDirectory === 'function' &&
  typeof backend.createFile === 'function' &&
  typeof backend.deletePath === 'function' &&
  typeof backend.renamePath === 'function' &&
  typeof backend.writeFileBytes === 'function'
