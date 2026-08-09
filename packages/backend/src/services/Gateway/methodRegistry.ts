/**
 * methodRegistry — the single source of truth for the WebSocket gateway's RPC
 * method surface. The adapter's dispatch, the `gateway:describe` self-discovery
 * endpoint, the agent's `list_gateway_methods` tool, and the reference docs all
 * derive from this one registry, so they can never drift.
 *
 * Each entry: { name, category, description, since, params? }.
 * `params` is a small JSON-Schema-ish shape for client codegen / introspection.
 */

export interface MethodParam {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description?: string
  optional?: boolean
}

export interface GatewayMethod {
  name: string
  category: string
  description: string
  since: string
  params?: Record<string, MethodParam>
}

function m(name: string, category: string, description: string, since: string, params?: Record<string, MethodParam>): GatewayMethod {
  return { name, category, description, since, ...(params ? { params } : {}) }
}

// ─── Core methods (gateway/session/agent/terminal/filesystem/system/models/skills/memory/settings/tools) ───
export const CORE_METHODS: GatewayMethod[] = [
  m('gateway:ping', 'gateway', 'Liveness check (pong).', '1.0.0'),
  m('gateway:isSameMachine', 'gateway', 'Whether the caller is on the same machine as the backend.', '1.0.0'),
  m('gateway:createSession', 'session', 'Create an agent session (returns sessionId).', '1.0.0'),
  m('session:list', 'session', 'List chat sessions.', '1.0.0'),
  m('session:get', 'session', 'Get one chat session by id.', '1.0.0', { sessionId: { type: 'string' } }),

  m('agent:startTask', 'agent', 'Start an AI agent task (blocking) and return the final answer.', '1.0.0', { sessionId: { type: 'string' }, userInput: { type: 'string' } }),
  m('agent:startTaskAsync', 'agent', 'Start an AI agent task (async; watch events for progress).', '1.0.0', { sessionId: { type: 'string' }, userInput: { type: 'string' } }),
  m('agent:stopTask', 'agent', 'Stop a running agent task.', '1.0.0', { taskId: { type: 'string' } }),
  m('agent:replyMessage', 'agent', 'Reply to a pending agent message (feedback).', '1.0.0'),
  m('agent:replyCommandApproval', 'agent', 'Approve/deny a pending command-approval request.', '1.0.0'),
  m('agent:deleteChatSession', 'agent', 'Delete one chat session.', '1.0.0', { sessionId: { type: 'string' } }),
  m('agent:deleteChatSessions', 'agent', 'Delete many chat sessions.', '1.0.0', { sessionIds: { type: 'array' } }),
  m('agent:renameSession', 'agent', 'Rename a chat session.', '1.0.0', { sessionId: { type: 'string' }, title: { type: 'string' } }),
  m('agent:branchFromMessage', 'agent', 'Branch a session from a message.', '1.0.0'),
  m('agent:rollbackToMessage', 'agent', 'Rollback a session to a message.', '1.0.0'),
  m('agent:exportHistory', 'agent', 'Export a session history (markdown).', '1.0.0', { sessionId: { type: 'string' } }),
  m('agent:getAllChatHistory', 'agent', 'List all chat history.', '1.0.0'),
  m('agent:loadChatSession', 'agent', 'Load a chat session into the UI.', '1.0.0', { sessionId: { type: 'string' } }),
  m('agent:getUiMessages', 'agent', 'Get UI messages for a session.', '1.0.0', { sessionId: { type: 'string' } }),

  m('terminal:list', 'terminal', 'List terminal tabs with runtime state.', '1.0.0'),
  m('terminal:createTab', 'terminal', 'Open a terminal tab (ssh/winrm/serial/local) from a config or saved connection.', '1.0.0', { config: { type: 'object' } }),
  m('terminal:write', 'terminal', 'Write data/keystrokes to a terminal.', '1.0.0', { terminalId: { type: 'string' }, data: { type: 'string' } }),
  m('terminal:writePaths', 'terminal', 'Write a sequence of inputs/control chars to a terminal.', '1.0.0', { terminalId: { type: 'string' }, sequence: { type: 'array' } }),
  m('terminal:resize', 'terminal', 'Resize a terminal (cols/rows).', '1.0.0', { terminalId: { type: 'string' }, cols: { type: 'number' }, rows: { type: 'number' } }),
  m('terminal:kill', 'terminal', 'Kill/close a terminal tab.', '1.0.0', { terminalId: { type: 'string' } }),
  m('terminal:reconnect', 'terminal', 'Reconnect a disconnected SSH tab in place.', '1.0.0', { terminalId: { type: 'string' } }),
  m('terminal:setTitle', 'terminal', 'Rename a terminal tab.', '1.0.0', { terminalId: { type: 'string' }, title: { type: 'string' } }),
  m('terminal:setSelection', 'terminal', 'Set the active/selected terminal tab.', '1.0.0', { terminalId: { type: 'string' } }),
  m('terminal:getBufferDelta', 'terminal', 'Read terminal output from an offset (delta).', '1.0.0', { terminalId: { type: 'string' }, fromOffset: { type: 'number' } }),
  m('terminal:generateCommandDraft', 'terminal', 'Draft a command for a tab from its recent output (paste-before-run).', '1.0.0', { terminalId: { type: 'string' } }),

  m('filesystem:list', 'filesystem', 'List a directory on a host.', '1.0.0', { terminalId: { type: 'string' }, path: { type: 'string' } }),
  m('filesystem:readTextFile', 'filesystem', 'Read a text file on a host.', '1.0.0', { terminalId: { type: 'string' }, path: { type: 'string' } }),
  m('filesystem:writeTextFile', 'filesystem', 'Write a text file on a host.', '1.0.0', { terminalId: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' } }),
  m('filesystem:transferEntries', 'filesystem', 'Prepare entries for a cross-host file transfer.', '1.0.0'),
  m('filesystem:startTransfer', 'filesystem', 'Start a cross-host file transfer.', '1.0.0'),
  m('filesystem:getTransfer', 'filesystem', 'Get a transfer status.', '1.0.0', { transferId: { type: 'string' } }),
  m('filesystem:listTransfers', 'filesystem', 'List transfers.', '1.0.0'),
  m('filesystem:cancelTransfer', 'filesystem', 'Cancel a transfer.', '1.0.0', { transferId: { type: 'string' } }),
  m('filesystem:cancelTransferTask', 'filesystem', 'Cancel a transfer task.', '1.0.0', { transferId: { type: 'string' } }),
  m('filesystem:createDirectory', 'filesystem', 'Create a directory on a host.', '1.0.0', { terminalId: { type: 'string' }, path: { type: 'string' } }),
  m('filesystem:createFile', 'filesystem', 'Create a file on a host.', '1.0.0', { terminalId: { type: 'string' }, path: { type: 'string' } }),
  m('filesystem:deletePath', 'filesystem', 'Delete a path on a host.', '1.0.0', { terminalId: { type: 'string' }, path: { type: 'string' } }),
  m('filesystem:renamePath', 'filesystem', 'Rename/move a path on a host.', '1.0.0', { terminalId: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } }),

  m('system:saveImageAttachment', 'system', 'Attach an image to the chat.', '1.0.0'),

  m('models:getProfiles', 'models', 'List model profiles.', '1.0.0'),
  m('models:setActiveProfile', 'models', 'Switch the active model profile.', '1.0.0', { profileId: { type: 'string' } }),
  m('models:probe', 'models', 'Probe a model (connectivity/capability).', '1.0.0', { model: { type: 'object' } }),

  m('skills:reload', 'skills', 'Reload skills from disk.', '1.0.0'),
  m('skills:getAll', 'skills', 'List all skills.', '1.0.0'),
  m('skills:getEnabled', 'skills', 'List enabled skills.', '1.0.0'),
  m('skills:create', 'skills', 'Create a skill.', '1.0.0'),
  m('skills:delete', 'skills', 'Delete a skill.', '1.0.0', { name: { type: 'string' } }),
  m('skills:list', 'skills', 'List skills.', '1.0.0'),
  m('skills:setEnabled', 'skills', 'Enable/disable a skill.', '1.0.0', { name: { type: 'string' }, enabled: { type: 'boolean' } }),

  m('memory:get', 'memory', 'Get global memory content.', '1.0.0'),
  m('memory:setContent', 'memory', 'Set global memory content.', '1.0.0', { content: { type: 'string' } }),

  m('agentSettings:get', 'settings', 'Get agent setting profiles.', '1.0.0'),
  m('agentSettings:saveCurrent', 'settings', 'Save current agent settings to a profile slot.', '1.0.0'),
  m('agentSettings:apply', 'settings', 'Apply an agent setting profile.', '1.0.0'),
  m('agentSettings:overwrite', 'settings', 'Overwrite an agent setting profile.', '1.0.0'),
  m('agentSettings:delete', 'settings', 'Delete an agent setting profile.', '1.0.0', { profileId: { type: 'string' } }),

  m('settings:get', 'settings', 'Get the full backend settings (incl. connections, automation, observability blocks).', '1.0.0'),
  m('settings:set', 'settings', 'Patch backend settings (deep-merged + persisted + live-reloaded).', '1.0.0', { settings: { type: 'object' } }),
  m('settings:getCommandPolicyLists', 'settings', 'Get command-policy allow/ask/deny lists.', '1.0.0'),
  m('settings:addCommandPolicyRule', 'settings', 'Add a rule to a command-policy list.', '1.0.0', { list: { type: 'string' }, rule: { type: 'string' } }),
  m('settings:deleteCommandPolicyRule', 'settings', 'Remove a rule from a command-policy list.', '1.0.0', { list: { type: 'string' }, rule: { type: 'string' } }),

  m('tools:reloadMcp', 'tools', 'Reload MCP tool servers.', '1.0.0'),
  m('tools:getMcp', 'tools', 'List MCP tools.', '1.0.0'),
  m('tools:setMcpEnabled', 'tools', 'Enable/disable an MCP tool.', '1.0.0'),
  m('tools:getBuiltIn', 'tools', 'List built-in agent tools with enabled state.', '1.0.0'),
  m('tools:setBuiltInEnabled', 'tools', 'Enable/disable a built-in tool.', '1.0.0', { name: { type: 'string' }, enabled: { type: 'boolean' } }),
]

// ─── Self-discovery (v3.0.0) ───
export const DESCRIBE_METHOD: GatewayMethod = m(
  'gateway:describe',
  'gateway',
  'Self-discovery: return the gateway method registry (this list) — names, categories, descriptions, params, and the version each was introduced. Optionally filter by category or a name prefix.',
  '3.0.0',
  { category: { type: 'string', optional: true }, prefix: { type: 'string', optional: true } },
)

/** Category order for stable, readable describe output. */
export const METHOD_CATEGORIES = [
  'gateway', 'session', 'agent', 'terminal', 'filesystem', 'system',
  'models', 'skills', 'memory', 'settings', 'tools', 'observability',
] as const

/** Build the full describe payload (core + self + observability, derived at call time). */
export function buildDescribePayload(observabilityMethods: Array<{ name: string; description?: string; since?: string }>): {
  version: string
  count: number
  categories: string[]
  methods: GatewayMethod[]
} {
  const obs: GatewayMethod[] = observabilityMethods.map((o) => ({
    name: o.name,
    category: 'observability',
    description: o.description ?? 'Observability/SRE RPC method.',
    since: o.since ?? '2.9.0',
  }))
  const methods = [...CORE_METHODS, DESCRIBE_METHOD, ...obs]
  return {
    version: '3.0.0',
    count: methods.length,
    categories: [...METHOD_CATEGORIES],
    methods,
  }
}
