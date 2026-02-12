import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { loadMcpTools } from '@langchain/mcp-adapters'
import type { StructuredTool } from '@langchain/core/tools'

export type McpServerStatus = 'disabled' | 'connecting' | 'connected' | 'error'

export interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  serverUrl?: string
  headers?: Record<string, string>
  enable?: boolean
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>
}

export interface McpServerSummary {
  name: string
  enabled: boolean
  status: McpServerStatus
  error?: string
  toolCount?: number
}

interface McpServerState {
  name: string
  enabled: boolean
  status: McpServerStatus
  error?: string
  config: McpServerConfig
  client?: Client
  transport?: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport
  tools: StructuredTool[]
}

export interface McpRuntimeCoreOptions {
  getConfigPath: () => string
  openPath?: (absolutePath: string) => Promise<void>
  readTemplateConfig?: () => Promise<McpConfigFile | undefined>
  logger?: {
    info: (message: string) => void
    warn: (message: string, error?: unknown) => void
    error: (message: string, error?: unknown) => void
  }
}

function defaultConfig(): McpConfigFile {
  return { mcpServers: {} }
}

export class McpRuntimeCore extends EventEmitter {
  private config: McpConfigFile = defaultConfig()
  private servers: Map<string, McpServerState> = new Map()
  private toolByName: Map<string, StructuredTool> = new Map()
  private readonly logger: {
    info: (message: string) => void
    warn: (message: string, error?: unknown) => void
    error: (message: string, error?: unknown) => void
  }

  constructor(private readonly options: McpRuntimeCoreOptions) {
    super()
    this.logger = options.logger ?? console
  }

  getConfigPath(): string {
    return this.options.getConfigPath()
  }

  async openConfigFile(): Promise<void> {
    if (!this.options.openPath) {
      throw new Error('Open operation is not supported in this runtime')
    }
    await this.ensureConfigFile()
    await this.options.openPath(this.getConfigPath())
  }

  async reloadAll(): Promise<McpServerSummary[]> {
    this.config = await this.loadConfig()
    await this.stopAll()
    await this.startEnabledServers()
    const summaries = this.getSummaries()
    this.emit('updated', summaries)
    return summaries
  }

  getSummaries(): McpServerSummary[] {
    const names = Object.keys(this.config.mcpServers || {})
    return names.map((name) => this.toSummary(name))
  }

  async setServerEnabled(name: string, enabled: boolean): Promise<McpServerSummary[]> {
    const config = await this.loadConfig()
    if (!config.mcpServers[name]) {
      throw new Error(`MCP server "${name}" not found in config`)
    }

    config.mcpServers[name].enable = enabled
    await this.writeConfig(config)
    this.config = config

    if (enabled) {
      await this.startServer(name, config.mcpServers[name])
    } else {
      await this.stopServer(name)
    }

    const summaries = this.getSummaries()
    this.emit('updated', summaries)
    return summaries
  }

  isMcpToolName(toolName: string): boolean {
    return this.toolByName.has(toolName)
  }

  getActiveTools(): StructuredTool[] {
    const tools: StructuredTool[] = []
    for (const state of this.servers.values()) {
      if (state.enabled && state.status === 'connected') {
        tools.push(...state.tools)
      }
    }
    return tools
  }

  async invokeTool(toolName: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    const tool = this.toolByName.get(toolName)
    if (!tool) {
      throw new Error(`MCP tool "${toolName}" not found`)
    }
    return tool.invoke(args, { signal })
  }

  private async ensureConfigFile(): Promise<void> {
    const filePath = this.getConfigPath()
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false)
    if (exists) return

    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const template = (await this.options.readTemplateConfig?.()) ?? defaultConfig()
    await fs.writeFile(filePath, JSON.stringify(template, null, 2), 'utf8')
  }

  private async loadConfig(): Promise<McpConfigFile> {
    await this.ensureConfigFile()
    const filePath = this.getConfigPath()

    try {
      const raw = await fs.readFile(filePath, 'utf8')
      const parsed = JSON.parse(raw)
      const normalized = this.normalizeConfig(parsed)
      if (normalized.didChange) {
        await this.writeConfig(normalized.config)
      }
      return normalized.config
    } catch {
      return defaultConfig()
    }
  }

  private normalizeConfig(raw: unknown): { config: McpConfigFile; didChange: boolean } {
    const next: McpConfigFile = defaultConfig()
    let didChange = false

    if (!raw || typeof raw !== 'object') {
      return { config: next, didChange: true }
    }

    const root = raw as Record<string, unknown>
    const servers = root.mcpServers && typeof root.mcpServers === 'object' ? root.mcpServers : {}

    for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
      if (!cfg || typeof cfg !== 'object') continue
      const record = cfg as Record<string, unknown>
      const enable = typeof record.enable === 'boolean' ? record.enable : false
      if (record.enable === undefined) {
        didChange = true
      }

      next.mcpServers[name] = {
        command: typeof record.command === 'string' ? record.command : undefined,
        args: Array.isArray(record.args) ? record.args.map(String) : undefined,
        env: record.env && typeof record.env === 'object' ? (record.env as Record<string, string>) : undefined,
        url: typeof record.url === 'string' ? record.url : undefined,
        serverUrl: typeof record.serverUrl === 'string' ? record.serverUrl : undefined,
        headers:
          record.headers && typeof record.headers === 'object' ? (record.headers as Record<string, string>) : undefined,
        enable
      }
    }

    return { config: next, didChange }
  }

  private async writeConfig(config: McpConfigFile): Promise<void> {
    const filePath = this.getConfigPath()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf8')
  }

  private async startEnabledServers(): Promise<void> {
    for (const [name, cfg] of Object.entries(this.config.mcpServers || {})) {
      if (cfg.enable) {
        await this.startServer(name, cfg)
      } else {
        this.ensureDisabledState(name, cfg)
      }
    }
  }

  private ensureDisabledState(name: string, config: McpServerConfig): void {
    const existing = this.servers.get(name)
    if (existing) {
      existing.enabled = false
      existing.status = 'disabled'
      existing.tools = []
      existing.error = undefined
      return
    }

    this.servers.set(name, {
      name,
      enabled: false,
      status: 'disabled',
      config,
      tools: []
    })
  }

  private async startServer(name: string, config: McpServerConfig): Promise<void> {
    const state: McpServerState = {
      name,
      enabled: true,
      status: 'connecting',
      config,
      tools: []
    }
    this.servers.set(name, state)

    try {
      const transport = config.serverUrl
        ? new SSEClientTransport(new URL(config.serverUrl), {
            requestInit: {
              headers: config.headers || {}
            }
          })
        : config.url
        ? new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: {
              headers: config.headers || {}
            }
          })
        : new StdioClientTransport({
            command: config.command || '',
            args: config.args || [],
            env: this.buildEnv(config.env)
          })

      const client = new Client({ name: `gyshell-mcp-${name}`, version: '1.0.0' }, { capabilities: {} })
      await client.connect(transport)

      const tools = await loadMcpTools(name, client, {
        throwOnLoadError: true,
        prefixToolNameWithServerName: false
      })

      const renamed = tools.map((tool) => this.renameTool(name, tool as StructuredTool))
      state.client = client
      state.transport = transport
      state.tools = renamed
      state.status = 'connected'
      state.error = undefined
    } catch (error) {
      state.status = 'error'
      state.error = error instanceof Error ? error.message : String(error)
      state.tools = []
      await this.cleanupServer(name)
      this.logger.warn(`[McpRuntimeCore] Failed to start MCP server ${name}.`, error)
    }
  }

  private buildEnv(extra?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') {
        env[key] = value
      }
    }

    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        if (typeof value === 'string') {
          env[key] = value
        }
      }
    }

    return env
  }

  private renameTool(serverName: string, tool: StructuredTool): StructuredTool {
    const original = (tool as any).name || 'tool'
    const renamed = `${serverName}__${original}`
    ;(tool as any).name = renamed
    if (typeof (tool as any).description === 'string') {
      ;(tool as any).description = `[${serverName}] ${(tool as any).description}`
    }
    this.toolByName.set(renamed, tool)
    return tool
  }

  private async stopAll(): Promise<void> {
    const names = Array.from(this.servers.keys())
    for (const name of names) {
      await this.stopServer(name)
    }
    this.servers.clear()
    this.toolByName.clear()
  }

  private async stopServer(name: string): Promise<void> {
    const state = this.servers.get(name)
    if (!state) return

    await this.cleanupServer(name)
    state.enabled = false
    state.status = 'disabled'
    state.tools = []
    state.error = undefined

    this.toolByName.forEach((_tool, key) => {
      if (key.startsWith(`${name}__`)) {
        this.toolByName.delete(key)
      }
    })
  }

  private async cleanupServer(name: string): Promise<void> {
    const state = this.servers.get(name)
    if (!state) return

    if (state.client) {
      try {
        await state.client.close()
      } catch {
        // ignore cleanup errors
      }
    }

    if (state.transport) {
      try {
        await state.transport.close()
      } catch {
        // ignore cleanup errors
      }
    }

    state.client = undefined
    state.transport = undefined
  }

  private toSummary(name: string): McpServerSummary {
    const config = this.config.mcpServers[name]
    const state = this.servers.get(name)
    const enabled = config?.enable ?? false

    if (!state) {
      return {
        name,
        enabled,
        status: enabled ? 'connecting' : 'disabled'
      }
    }

    return {
      name,
      enabled,
      status: state.status,
      error: state.error,
      toolCount: state.tools.length
    }
  }
}
