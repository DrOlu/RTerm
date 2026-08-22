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
  /** Per-model OpenAI-compatible request-body overrides (v3.2.9). Typed values
   * merged over runtime defaults; runtime-owned fields (model, messages, tools,
   * stream) are protected and cannot be overridden. Model-level wins over
   * profile-level when both define the same field. */
  requestParams?: Record<string, string | number | boolean | object>
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
  /**
   * The review/checker model — independently verifies the action model's output
   * for correctness, completeness, safety, compliance, and accuracy.
   * If NOT specified, reviews are skipped entirely (fast output mode).
   */
  reviewModelId?: string
  /** how strict the review is: 'strict' (block on any issue), 'advisory' (flag but allow), 'auto-approve' (skip review for low-risk actions). */
  reviewMode?: 'strict' | 'advisory' | 'auto-approve'
  /** Per-model OpenAI-compatible request-body overrides (v3.2.4). Typed values
   * merged over runtime defaults; runtime-owned fields (model, messages, tools,
   * stream) are protected and cannot be overridden. */
  requestParams?: Record<string, string | number | boolean | object>
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
  /** Optional SSH handshake ready-timeout in ms (v3.0.6). Overrides the default
   * (60s). Raise further for very slow legacy negotiation; lower for fast LAN. */
  readyTimeout?: number
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
  /** Event-driven triggers (Advanced Automation v1.9.1) — optional for
   * backward compatibility with older settings files. */
  triggers?: TriggerEntry[]
}

/** Event-driven automation trigger (Advanced Automation v1.9.1). */
export interface TriggerEntry {
  id: string
  name: string
  enabled: boolean
  kind: 'pattern' | 'threshold' | 'webhook' | 'schedule'
  /** pattern: text/regex to match in terminal output. */
  match?: string
  matchMode?: 'substring' | 'regex'
  /** threshold: metric name + comparison. */
  metric?: string
  op?: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'
  value?: number
  /** only react to these hosts (empty = all). */
  scopeHosts?: string[]
  action: 'run-playbook' | 'propose-change'
  /** playbook id or name to run/propose on match. */
  playbookId: string
  /** seconds between firings of THIS trigger (default 300). */
  cooldownSeconds?: number
  createdAt: number
  lastFiredAt?: number
  fireCount?: number
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

  // --- Advanced orchestration (v1.9.1) ---
  /**
   * DAG mode: ids of steps that must complete before this step runs (within a
   * single target). Empty/undefined = depends on the previous step (linear).
   * Steps whose dependencies are met run as soon as possible (subject to the
   * playbook's maxParallelSteps cap).
   */
  dependsOn?: string[]
  /**
   * Idempotent-config mode: declare a desired-state check. If `validate` passes
   * BEFORE running the command, the command is skipped (already in desired
   * state) — so re-running the playbook is a no-op. Enables converge-style
   * automation instead of blind re-execution.
   */
  desiredState?: {
    /** check command; if its output matches `expect`, the step is skipped. */
    command?: string
    scriptId?: string
    expect: string
    expectMode?: 'substring' | 'regex'
  }
  /** Named capture: store a regex/substring extraction from this step's output
   * into the run's variable map for later steps (cross-host orchestration vars). */
  captureVar?: { name: string; pattern: string; regex?: boolean }
}

/** A named playbook parameter (runbook inputs injected at run time). */
export interface PlaybookParam {
  name: string
  /** default value when not supplied at run time. */
  defaultValue?: string
  /** marks the value as a secret — masked in run records / logs. */
  secret?: boolean
  description?: string
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
  /**
   * DAG/parallel mode: max steps that may run concurrently within a single
   * target when using dependsOn graphs (default 1 = strictly sequential).
   */
  maxParallelSteps?: number
  /** Runbook parameters: values are injected at run time and substituted into
   * step commands as {{param.name}}. `secret` params are masked in records. */
  params?: PlaybookParam[]
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

/** USD price for one model, per 1M tokens (AI cost attribution). */
export interface ModelPriceEntry {
  /** USD per 1M prompt/input tokens. */
  promptPer1M: number
  /** USD per 1M completion/output tokens. */
  completionPer1M: number
}

/** A persisted AI-spend budget (daily/monthly cap with warn/throttle/deny). */
export interface CostBudgetEntry {
  id: string
  /** scope: which model this budget covers ('*' or undefined = all). */
  model?: string
  /** optional profile/actor attribution scope. */
  profileId?: string
  /** window the budget is measured over. */
  period: 'daily' | 'monthly'
  /** USD cap for the window. */
  capUsd: number
  /** fraction of cap that triggers 'warn' (default 0.8). */
  warnAt?: number
  /** when over cap: 'throttle' (flag, allow) or 'deny' (block). */
  overAction?: 'throttle' | 'deny'
}

/**
 * AI cost configuration: the model price table that turns the run ledger's
 * token counts into dollars, plus persisted spend budgets. Persisted in
 * settings so cost attribution + budgets survive restarts (no placeholders).
 */
export interface CostSettings {
  /**
   * Price table keyed by model id. The special key `default` is used as a
   * fallback for any model without an explicit entry. Values are USD per 1M
   * tokens.
   */
  modelPrices: Record<string, ModelPriceEntry>
  /** Persisted spend budgets. */
  budgets: CostBudgetEntry[]
}

/**
 * A persisted alert-notification channel. Secrets (webhook URLs, bot tokens,
 * SMTP passwords) are NEVER stored inline — `secretRef` points at a key in the
 * AES-256-GCM secrets vault, resolved only at send time.
 */
export interface AlertChannelEntry {
  id: string
  /** human label shown in the UI. */
  name: string
  type: 'slack' | 'teams' | 'smtp' | 'telegram'
  /** minimum severity to route (info < warning < critical); default info. */
  minSeverity?: 'info' | 'warning' | 'critical'
  /** enable/disable without deleting the channel. */
  enabled: boolean
  /**
   * Reference to the vault key holding the channel secret:
   * slack/teams → webhook URL, telegram → bot token, smtp → password.
   */
  secretRef?: string
  /** telegram: target chat id. */
  chatId?: string
  /** smtp: sender + recipients + host/port/user (password via secretRef). */
  smtp?: {
    host: string
    port: number
    secure?: boolean
    user?: string
    from: string
    to: string[]
  }
}

/** Alert-notification configuration: the channel list routed by AlertService. */
export interface AlertsSettings {
  channels: AlertChannelEntry[]
}

/**
 * A persisted on-call paging channel. Like AlertChannelEntry but adds a generic
 * outbound `webhook` type (POST a page JSON to any URL). Secrets (webhook URLs,
 * bot tokens, SMTP passwords) live in the vault via `secretRef`, never inline.
 * A page targets a channel by its `name`.
 */
export interface PagingChannelEntry {
  id: string
  /** channel name — pages reference this in policy targets. */
  name: string
  type: 'slack' | 'teams' | 'smtp' | 'telegram' | 'webhook'
  /** minimum severity to page (info < warning < critical); default info. */
  minSeverity?: 'info' | 'warning' | 'critical'
  /** enable/disable without deleting the channel. */
  enabled: boolean
  /** vault key holding the channel secret (webhook URL / bot token / smtp password). */
  secretRef?: string
  /** telegram: default chat id (target.id overrides when set). */
  chatId?: string
  /** webhook: URL may be inline (non-secret) or via secretRef. */
  webhookUrl?: string
  /** smtp: sender + recipients + host/port/user (password via secretRef). */
  smtp?: {
    host: string
    port: number
    secure?: boolean
    user?: string
    from: string
    to: string[]
  }
}

/** On-call paging configuration: the paging-channel list used by EscalationService. */
export interface OncallSettings {
  pagingChannels: PagingChannelEntry[]
}

/**
 * A persisted cloud account for inventory. Credentials are NOT stored inline —
 * `secretRef` points at a vault key whose value is a provider credential env
 * blob (e.g. "AWS_ACCESS_KEY_ID=…\nAWS_SECRET_ACCESS_KEY=…" or a named profile),
 * resolved at sync time. When no accounts are configured, CloudInventory falls
 * back to the ambient provider CLI credentials.
 */
export interface CloudAccountEntry {
  id: string
  provider: 'aws' | 'gcp' | 'azure'
  /** display alias. */
  name: string
  /** account id / project id / subscription id. */
  accountId: string
  /** optional region/location scope for the list call. */
  region?: string
  /** vault key holding the credential env/profile blob. */
  secretRef?: string
  /** enable/disable without deleting the account. */
  enabled: boolean
}

/** Cloud-inventory configuration: the account list synced by CloudInventory. */
export interface CloudSettings {
  accounts: CloudAccountEntry[]
}

/**
 * AgentSpan/Conductor bridge configuration. The agentspan-bridge plugin reads
 * this to reach an AgentSpan (Conductor) server. Auth is optional and never
 * inline — `authSecretRef` points at a vault key holding
 * "AGENTSPAN_AUTH_KEY=…\nAGENTSPAN_AUTH_SECRET=…".
 */
export interface AgentspanSettings {
  /** AgentSpan/Conductor server base URL (default http://localhost:6767). */
  serverUrl?: string
  /** vault key holding the AgentSpan standalone auth key/secret blob. */
  authSecretRef?: string
  /** enable/disable the bridge without removing config. */
  enabled?: boolean
}

/**
 * Web-intel (wigolo) configuration. The web-intel plugin reads this to reach the
 * local wigolo daemon. Synthesis uses RTerm's own agent — no LLM key is stored.
 * Lean by default: warmupOnInit=false keeps the ~1.5 GB browser-engine/model
 * download opt-in.
 */
export interface WebIntelSettings {
  /** wigolo daemon base URL (default http://127.0.0.1:3333). */
  restUrl?: string
  /** bearer token (optional; only if the daemon uses WIGOLO_API_TOKEN). */
  token?: string
  /** master switch (default true). */
  enabled?: boolean
  /** start the daemon on first use (default true). */
  autoStart?: boolean
  /** download the full browser engine + on-device models in the background
   * (default false = lean; search/fetch/crawl work keyless without them). */
  warmupOnInit?: boolean
}

/**
 * NATS event-mesh configuration. The NatsEventBus reads this to connect to a
 * NATS server and federate trigger events (terminal output + monitor snapshots)
 * across backend instances. Auth is optional (open servers need none); secrets
 * may be inline or `secretRef` pointers resolved through the vault.
 */
export interface NatsSettings {
  /** master switch (default true when a server is configured). */
  enabled?: boolean
  /** single server url, e.g. "nats://localhost:4222". */
  url?: string
  /** multiple server urls (takes precedence over `url`). */
  servers?: string[]
  /** subject prefix (default "rterm"). */
  prefix?: string
  /** default queue group for subscriptions (load-balance across instances). */
  queue?: string
  /** max reconnect attempts (-1 = unlimited). */
  maxReconnectAttempts?: number
  /** reconnect wait between attempts (ms). */
  reconnectTimeWait?: number
  /** connect timeout (ms). */
  timeout?: number
  /** auth options (token / user-pass / nkey / jwt / creds / tls). */
  auth?: {
    token?: string
    username?: string
    password?: string
    nkeySeed?: string
    jwt?: string
    jwtSeed?: string
    creds?: string
    tlsCert?: string
    tlsKey?: string
    tlsCa?: string
  }
}

/**
 * Synapse mesh bridge configuration (synapse-bridge plugin). RTerm speaks the
 * Synapse protocol (v0.3.0) over a shared NATS server to discover/dispatch mesh
 * agents and register itself. Auth optional; secrets inline or via vault secretRef.
 */
export interface SynapseSettings {
  /** master switch (default true when a server is configured). */
  enabled?: boolean
  /** NATS server url (default nats://localhost:4222). */
  url?: string
  /** multiple server urls (takes precedence over `url`). */
  servers?: string[]
  /** mesh subject prefix (default "mesh"). */
  prefix?: string
  /** this instance's mesh agent id (default "rterm-001"). */
  agentId?: string
  /** auth options (token / user-pass / nkey / jwt / creds / tls). */
  auth?: {
    token?: string
    tokenSecretRef?: string
    username?: string
    password?: string
    passwordSecretRef?: string
    nkeySeed?: string
    jwt?: string
    jwtSeed?: string
    creds?: string
    tlsCert?: string
    tlsKey?: string
    tlsCa?: string
  }
  /** auto-start the full-duplex responder on boot (default true). */
  autoServe?: boolean
  /** dispatch timeout in ms (default 600000 = 10min for LLM-backed agents). */
  dispatchTimeout?: number
  /** multiple meshes (v3.2.0). Each: {name, url/servers, auth, prefix?}. */
  meshes?: SynapseMesh[]
}

/** A single Synapse mesh configuration (for multi-mesh support, v3.2.0). */
export interface SynapseMesh {
  /** mesh name (for tagging discovered agents). */
  name?: string
  /** NATS server url. */
  url?: string
  /** multiple server urls. */
  servers?: string[]
  /** mesh subject prefix (default "mesh"). */
  prefix?: string
  /** auth options. */
  auth?: SynapseSettings['auth']
}

/**
 * Numbat bridge configuration (numbat-bridge plugin). Deploy Numbat (endpoint
 * AI-agent detection/EDR) to hosts and ingest its findings to fire RTerm triggers.
 */
export interface NumbatSettings {
  /** master switch (default true). */
  enabled?: boolean
  /** path to the numbat binary (default "numbat" on PATH). */
  binaryPath?: string
  /** local NDJSON records file to read (default ~/.numbat/records.ndjson). */
  recordsPath?: string
  /** bearer token the HTTP ingest endpoint requires (vault secretRef ok). */
  ingestToken?: string
  /** only ingest findings at/above this severity (info|low|medium|high|critical). */
  minSeverity?: 'info' | 'low' | 'medium' | 'high' | 'critical'
}

export interface BackendSettings {
  /** Settings schema version, used for migrations */
  schemaVersion: 5

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

  /** AI cost attribution: model price table + persisted spend budgets. */
  cost?: CostSettings

  /** Alert-notification channels (slack/teams/smtp/telegram), secrets via vault. */
  alerts?: AlertsSettings

  /** On-call paging channels (slack/teams/smtp/telegram/webhook), secrets via vault. */
  oncall?: OncallSettings

  /** Cloud-inventory accounts (aws/gcp/azure), credentials via vault. */
  cloud?: CloudSettings

  /** AgentSpan/Conductor bridge (durable agent runtime), auth via vault. */
  agentspan?: AgentspanSettings
  /** Web-intel (wigolo) web-intelligence plugin config. */
  webIntel?: WebIntelSettings
  /** NATS event-mesh (fleet-wide triggers), auth optional. */
  nats?: NatsSettings
  /** Synapse mesh bridge (discover/dispatch/register mesh agents). */
  synapse?: SynapseSettings
  /** Numbat bridge (endpoint AI-agent detection → triggers). */
  numbat?: NumbatSettings

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
  /** Optional SSH handshake ready-timeout in ms (v3.0.6). Overrides the default
   * (60s). Raise further for very slow legacy negotiation; lower for fast LAN. */
  readyTimeout?: number
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
  /** auto-reconnect state (v3.0.5): present while a reconnect is being scheduled/attempted. */
  reconnectState?: {
    /** whether a reconnect attempt is currently scheduled. */
    scheduled: boolean
    /** the attempt number that will fire / fired next (1-based). */
    attempt: number
    /** attempts fired so far. */
    attempts: number
    /** delay (ms) before the next attempt. */
    nextDelayMs: number
    /** whether the schedule gave up (max attempts reached). */
    gaveUp?: boolean
  }
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
  /** v3.2.5: capture status — tells the agent if output is complete, partial, or truncated. */
  captureStatus?: 'complete' | 'partial' | 'display-truncated'
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
  /** v3.2.5: capture status — distinguishes complete, partial, and display-truncated output. */
  captureStatus?: 'complete' | 'partial' | 'display-truncated'
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
  ): Promise<{ stdout: string; stderr: string; stdoutStream?: AsyncIterable<Buffer> } | null>

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
  /**
   * v3.2.9: when true, the returned result carries a `stdoutStream` (an async
   * iterable of Buffers) instead of a buffered `stdout` string. Used by the
   * SSH→SSH direct transfer path to stream file bytes without buffering the
   * whole payload in memory. Backends that don't support streaming ignore it
   * and return the buffered shape (callers must handle both).
   */
  streamStdout?: boolean
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
