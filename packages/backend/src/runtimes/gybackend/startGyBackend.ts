import path from 'node:path'
import process from 'node:process'
import fs from 'node:fs/promises'
import { TerminalService } from '../../services/TerminalService'
import { AgentService_v2 } from '../../services/AgentService_v2'
import { UIHistoryService } from '../../services/UIHistoryService'
import { ChatHistoryService } from '../../services/ChatHistoryService'
import { GatewayService } from '../../services/Gateway/GatewayService'
import { WebSocketGatewayAdapter } from '../../services/Gateway/WebSocketGatewayAdapter'
import {
  WebSocketGatewayControlService,
  resolveWsGatewayAccessFromHost,
  resolveWsGatewayPolicyFromEnv
} from '../../services/Gateway/WebSocketGatewayControlService'
import { NodeSettingsService } from '../../adapters/node/NodeSettingsService'
import { NodeCommandPolicyService } from '../../adapters/node/NodeCommandPolicyService'
import { NodeMcpToolService } from '../../adapters/node/NodeMcpToolService'
import { NodeSkillService } from '../../adapters/node/NodeSkillService'
import { ModelCapabilityService } from '../../services/ModelCapabilityService'
import { BUILTIN_TOOL_INFO } from '../../services/AgentHelper/tools'

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (!raw) return fallback
  return /^(1|true|yes|on)$/i.test(raw)
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] || '')
  if (!Number.isInteger(raw) || raw <= 0 || raw >= 65536) {
    return fallback
  }
  return raw
}

function resolveDataDir(): string {
  const custom = (process.env.GYBACKEND_DATA_DIR || '').trim()
  if (custom) {
    return path.resolve(custom)
  }
  return path.join(process.cwd(), '.gybackend-data')
}

function createAutoTerminalConfig(
  terminals: Array<{ id: string; title: string }>,
  partial: Record<string, any> = {}
): Record<string, any> {
  const requestedType = partial.type === 'ssh' ? 'ssh' : 'local'
  const ids = new Set(terminals.map((terminal) => terminal.id))
  const localCount = terminals.filter((terminal) => terminal.id.startsWith('local-') || terminal.id === 'local-main').length
  const sshCount = terminals.filter((terminal) => terminal.id.startsWith('ssh-')).length

  const nextTerminalId = (() => {
    if (typeof partial.id === 'string' && partial.id.trim().length > 0 && !ids.has(partial.id.trim())) {
      return partial.id.trim()
    }
    const prefix = requestedType === 'ssh' ? 'ssh' : 'local'
    const base = requestedType === 'ssh' ? sshCount + 1 : Math.max(2, localCount + 1)
    let index = base
    let candidate = `${prefix}-${index}`
    while (ids.has(candidate)) {
      index += 1
      candidate = `${prefix}-${index}`
    }
    return candidate
  })()

  const cols = Number.isInteger(partial.cols) && partial.cols > 0 ? Number(partial.cols) : 120
  const rows = Number.isInteger(partial.rows) && partial.rows > 0 ? Number(partial.rows) : 32
  const title =
    typeof partial.title === 'string' && partial.title.trim().length > 0
      ? partial.title.trim()
      : requestedType === 'ssh'
        ? `SSH (${sshCount + 1})`
        : `Local (${localCount + 1})`

  return {
    ...partial,
    type: requestedType,
    id: nextTerminalId,
    title,
    cols,
    rows
  }
}

async function saveTempPaste(dataDir: string, content: string): Promise<string> {
  const tmpDir = path.join(dataDir, 'tmp_pastes')
  await fs.mkdir(tmpDir, { recursive: true })
  const fileName = `paste_${Date.now()}_${Math.random().toString(16).slice(2, 10)}.txt`
  const filePath = path.join(tmpDir, fileName)
  await fs.writeFile(filePath, content, 'utf8')
  return filePath
}

export async function startGyBackend(): Promise<void> {
  const dataDir = resolveDataDir()
  process.env.GYSHELL_STORE_DIR = dataDir
  const defaultHost = (process.env.GYBACKEND_WS_HOST || '0.0.0.0').trim() || '0.0.0.0'
  const defaultPort = numberFromEnv('GYBACKEND_WS_PORT', 17888)
  const startupPolicy = resolveWsGatewayPolicyFromEnv({
    env: process.env,
    defaultPolicy: {
      access: resolveWsGatewayAccessFromHost(defaultHost),
      port: defaultPort,
      hostOverride: defaultHost
    },
    enableVarName: 'GYBACKEND_WS_ENABLE',
    hostVarName: 'GYBACKEND_WS_HOST',
    portVarName: 'GYBACKEND_WS_PORT'
  })
  const bootstrapLocalTerminal = boolFromEnv('GYBACKEND_BOOTSTRAP_LOCAL_TERMINAL', true)

  const settingsService = new NodeSettingsService(dataDir)
  const commandPolicyService = new NodeCommandPolicyService(dataDir)
  const mcpToolService = new NodeMcpToolService(dataDir)
  const skillService = new NodeSkillService(dataDir, settingsService)
  const modelCapabilityService = new ModelCapabilityService()

  const terminalService = new TerminalService()
  const uiHistoryService = new UIHistoryService()
  const chatHistoryService = new ChatHistoryService()
  const agentService = new AgentService_v2(
    terminalService,
    commandPolicyService,
    mcpToolService,
    skillService,
    uiHistoryService,
    chatHistoryService
  )

  const gatewayService = new GatewayService(
    terminalService,
    agentService,
    uiHistoryService,
    commandPolicyService,
    settingsService,
    mcpToolService
  )

  agentService.updateSettings(settingsService.getSettings())
  await skillService.reload()
  await mcpToolService.reloadAll()

  if (bootstrapLocalTerminal) {
    const terminalId = process.env.GYBACKEND_TERMINAL_ID || 'local-main'
    const terminalTitle = process.env.GYBACKEND_TERMINAL_TITLE || 'Local'
    const terminalCwd = process.env.GYBACKEND_TERMINAL_CWD
    const terminalShell = process.env.GYBACKEND_TERMINAL_SHELL

    try {
      await terminalService.createTerminal({
        type: 'local',
        id: terminalId,
        title: terminalTitle,
        cols: 120,
        rows: 32,
        cwd: terminalCwd,
        shell: terminalShell
      })
      console.log(`[gybackend] Bootstrapped terminal: ${terminalId}`)
    } catch (error) {
      console.warn('[gybackend] Failed to bootstrap default terminal:', error)
    }
  }

  const wsGatewayControlService = new WebSocketGatewayControlService({
    createAdapter: (host, port) =>
      new WebSocketGatewayAdapter(gatewayService, {
        host,
        port,
        terminalBridge: {
          listTerminals: () =>
            terminalService.getAllTerminals().map((terminal) => ({
              id: terminal.id,
              title: terminal.title,
              type: terminal.type
            })),
          createTab: async (config) => {
            const snapshot = terminalService.getAllTerminals()
            const normalized = createAutoTerminalConfig(snapshot, config)
            const tab = await terminalService.createTerminal(normalized as any)
            return { id: tab.id }
          },
          write: async (terminalId, data) => {
            terminalService.write(terminalId, data)
          },
          writePaths: async (terminalId, paths) => {
            terminalService.writePaths(terminalId, paths)
          },
          resize: async (terminalId, cols, rows) => {
            terminalService.resize(terminalId, cols, rows)
          },
          kill: async (terminalId) => {
            if (terminalService.getAllTerminals().length <= 1) {
              throw new Error('Cannot close the last terminal tab.')
            }
            terminalService.kill(terminalId)
          },
          setSelection: async (terminalId, selectionText) => {
            terminalService.setSelection(terminalId, selectionText)
          }
        },
        profileBridge: {
          getProfiles: () => {
            const snapshot = settingsService.getSettings()
            const modelNameById = new Map(snapshot.models.items.map((item) => [item.id, item.model]))
            return {
              activeProfileId: snapshot.models.activeProfileId,
              profiles: snapshot.models.profiles.map((profile) => ({
                id: profile.id,
                name: profile.name,
                globalModelId: profile.globalModelId,
                modelName: modelNameById.get(profile.globalModelId)
              }))
            }
          },
          setActiveProfile: (profileId: string) => {
            const snapshot = settingsService.getSettings()
            const exists = snapshot.models.profiles.some((profile) => profile.id === profileId)
            if (!exists) {
              throw new Error(`Profile not found: ${profileId}`)
            }

            settingsService.setSettings({
              models: {
                items: snapshot.models.items,
                profiles: snapshot.models.profiles,
                activeProfileId: profileId
              }
            })

            const next = settingsService.getSettings()
            agentService.updateSettings(next)

            const modelNameById = new Map(next.models.items.map((item) => [item.id, item.model]))
            return {
              activeProfileId: next.models.activeProfileId,
              profiles: next.models.profiles.map((profile) => ({
                id: profile.id,
                name: profile.name,
                globalModelId: profile.globalModelId,
                modelName: modelNameById.get(profile.globalModelId)
              }))
            }
          },
          probeModel: async (model: any) => {
            return await modelCapabilityService.probe(model)
          }
        },
        agentBridge: {
          exportHistory: async (sessionId, mode) => {
            await gatewayService.waitForRunCompletion(sessionId)
            const backendSession = agentService.exportChatSession(sessionId)
            if (!backendSession) {
              throw new Error(`Session with ID ${sessionId} not found`)
            }
            const uiSession = uiHistoryService.getSession(sessionId)
            if (mode === 'simple') {
              const markdown = uiHistoryService.toReadableMarkdown(
                uiSession?.messages || [],
                uiSession?.title || backendSession.title
              )
              return {
                sessionId,
                mode,
                title: uiSession?.title || backendSession.title,
                content: markdown
              }
            }
            return {
              sessionId: backendSession.id,
              mode,
              title: uiSession?.title || backendSession.title,
              lastCheckpointOffset: backendSession.lastCheckpointOffset,
              createdAt: new Date(backendSession.createdAt).toISOString(),
              updatedAt: new Date(backendSession.updatedAt).toISOString(),
              frontendMessages: uiSession?.messages || [],
              backendMessages: backendSession.messages.map((msg: any) => ({
                messageId: msg.id,
                messageType: msg.type,
                messageData: msg.data
              }))
            }
          },
          getAllChatHistory: () => agentService.getAllChatHistory(),
          loadChatSession: (sessionId) => agentService.loadChatSession(sessionId),
          getUiMessages: (sessionId) => uiHistoryService.getMessages(sessionId)
        },
        systemBridge: {
          saveTempPaste: async (content: string) => {
            return await saveTempPaste(dataDir, content)
          }
        },
        skillBridge: {
          reload: async () => {
            return await skillService.reload()
          },
          getAll: async () => {
            return await skillService.getAll()
          },
          getEnabled: async () => {
            return await skillService.getEnabledSkills()
          },
          create: async () => {
            return await skillService.createSkillFromTemplate()
          },
          delete: async (fileName: string) => {
            await skillService.deleteSkillFile(fileName)
            return await skillService.getAll()
          },
          listSkills: async () => {
            const snapshot = settingsService.getSettings()
            const enabledMap = snapshot.tools?.skills ?? {}
            const skills = await skillService.getAll()
            return skills.map((skill) => ({
              name: skill.name,
              description: skill.description,
              enabled: enabledMap[skill.name] !== false
            }))
          },
          setSkillEnabled: async (name: string, enabled: boolean) => {
            const snapshot = settingsService.getSettings()
            const nextSkills = { ...(snapshot.tools?.skills ?? {}) }
            nextSkills[name] = enabled

            settingsService.setSettings({
              tools: {
                builtIn: snapshot.tools?.builtIn ?? {},
                skills: nextSkills
              }
            })

            const next = settingsService.getSettings()
            agentService.updateSettings(next)
            const skills = await skillService.getAll()
            const summary = skills.map((skill) => ({
              name: skill.name,
              description: skill.description,
              enabled: (next.tools?.skills ?? {})[skill.name] !== false
            }))
            gatewayService.broadcastRaw(
              'skills:updated',
              summary.filter((skill) => skill.enabled)
            )
            return summary
          }
        },
        settingsBridge: {
          getSettings: () => settingsService.getSettings(),
          setSettings: async (patch) => {
            if ((patch as any)?.gateway?.ws) {
              throw new Error('settings.gateway.ws is not configurable via websocket RPC.')
            }
            settingsService.setSettings(patch as any)
            const next = settingsService.getSettings()
            agentService.updateSettings(next)
            return next
          }
        },
        commandPolicyBridge: {
          getLists: async () => {
            return await commandPolicyService.getLists()
          },
          addRule: async (listName, rule) => {
            return await commandPolicyService.addRule(listName, rule)
          },
          deleteRule: async (listName, rule) => {
            return await commandPolicyService.deleteRule(listName, rule)
          }
        },
        toolsBridge: {
          reloadMcp: async () => {
            return await mcpToolService.reloadAll()
          },
          getMcp: () => mcpToolService.getSummaries(),
          setMcpEnabled: async (name, enabled) => {
            return await mcpToolService.setServerEnabled(name, enabled)
          },
          getBuiltIn: () => {
            const settings = settingsService.getSettings()
            const enabledMap = settings.tools?.builtIn ?? {}
            return BUILTIN_TOOL_INFO.map((tool) => ({
              name: tool.name,
              description: tool.description,
              enabled: enabledMap[tool.name] ?? true
            }))
          },
          setBuiltInEnabled: async (name, enabled) => {
            const settings = settingsService.getSettings()
            const nextBuiltIn = { ...(settings.tools?.builtIn ?? {}) }
            nextBuiltIn[name] = enabled
            settingsService.setSettings({ tools: { builtIn: nextBuiltIn, skills: settings.tools?.skills ?? {} } })
            const next = settingsService.getSettings()
            agentService.updateSettings(next)
            return BUILTIN_TOOL_INFO.map((tool) => ({
              name: tool.name,
              description: tool.description,
              enabled: nextBuiltIn[tool.name] ?? true
            }))
          }
        }
      })
  })
  await wsGatewayControlService.applyPolicy(startupPolicy)

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[gybackend] Received ${signal}, shutting down...`)
    try {
      await wsGatewayControlService.stop()
    } catch (error) {
      console.warn('[gybackend] Failed to stop websocket adapter cleanly:', error)
    }

    for (const terminal of terminalService.getAllTerminals()) {
      terminalService.kill(terminal.id)
    }

    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })

  console.log('[gybackend] Started.')
  const wsState = wsGatewayControlService.getState()
  if (wsState.running && wsState.host) {
    console.log(`[gybackend] WebSocket RPC endpoint: ws://${wsState.host}:${wsState.port}`)
  } else {
    console.log('[gybackend] WebSocket RPC endpoint: disabled')
  }
  console.log(`[gybackend] Data directory: ${dataDir}`)
  console.log(`[gybackend] Settings file: ${settingsService.getSettingsPath()}`)
}
