import { app, BrowserWindow, screen, shell } from 'electron'
import { join, resolve } from 'path'
import { SettingsService } from '../../../backend/src/services/SettingsService'
import { UiSettingsStore } from '../settings/UiSettingsStore'
import { TerminalService } from '../../../backend/src/services/TerminalService'
import { FileSystemService } from '../../../backend/src/services/FileSystemService'
import { AgentService_v2 } from '../../../backend/src/services/AgentService_v2'
import { CommandPolicyService } from '../../../backend/src/services/CommandPolicy/CommandPolicyService'
import { ModelCapabilityService } from '../../../backend/src/services/ModelCapabilityService'
import { McpToolService } from '../../../backend/src/services/McpToolService'
import { ThemeConfigStore } from '../theme/ThemeConfigStore'
import { applyPlatformWindowTweaks, getPlatformBrowserWindowOptions } from './platform/windowChrome'
import { SkillService } from '../../../backend/src/services/SkillService'
import { MemoryService } from '../../../backend/src/services/MemoryService'
import { UIHistoryService } from '../../../backend/src/services/UIHistoryService'
import { ChatHistoryService } from '../../../backend/src/services/ChatHistoryService'
import { GatewayService } from '../../../backend/src/services/Gateway/GatewayService'
import { ElectronGatewayIpcAdapter } from '../gateway/ElectronGatewayIpcAdapter'
import { ElectronWindowTransport } from '../gateway/ElectronWindowTransport'
import { WebSocketGatewayAdapter } from '../../../backend/src/services/Gateway/WebSocketGatewayAdapter'
import {
  WebSocketGatewayControlService,
  resolveWsGatewayPolicyFromEnv
} from '../../../backend/src/services/Gateway/WebSocketGatewayControlService'
import { TempFileService } from '../../../backend/src/services/TempFileService'
import { ImageAttachmentService } from '../../../backend/src/services/ImageAttachmentService'
import { VersionService } from '../../../backend/src/services/VersionService'
import { AccessTokenService } from '../../../backend/src/services/AccessToken/AccessTokenService'
import { ElectronAppSettingsMigration } from '../settings/ElectronAppSettingsMigration'
import { installCliLaunchers } from './CliInstallService'
import {
  buildBuiltInToolStatusSummary,
  buildSkillStatusSummary
} from '../../../backend/src/services/Gateway/toolingSummary'
import { TerminalStateStore } from '../../../backend/src/services/terminal/TerminalStateStore'

let mainWindow: BrowserWindow | null = null
let settingsService: SettingsService
let uiSettingsStore: UiSettingsStore
let terminalService: TerminalService
let fileSystemService: FileSystemService
let agentService: AgentService_v2
let commandPolicyService: CommandPolicyService
let modelCapabilityService: ModelCapabilityService
let mcpToolService: McpToolService
let themeStore: ThemeConfigStore
let skillService: SkillService
let memoryService: MemoryService
let uiHistoryService: UIHistoryService
let tempFileService: TempFileService
let imageAttachmentService: ImageAttachmentService
let versionService: VersionService
let accessTokenService: AccessTokenService
let webSocketGatewayControlService: WebSocketGatewayControlService | null = null

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

function createWindow(): void {
  const settings = settingsService.getSettings()
  const uiSettings = uiSettingsStore.getSettings()
  const savedWindow = settings.layout?.window

  let width = 800
  let height = 500
  let x: number | undefined
  let y: number | undefined

  if (savedWindow) {
    width = savedWindow.width
    height = savedWindow.height
    x = savedWindow.x
    y = savedWindow.y
  } else {
  // Match WaveTerm-like default sizing: fill most of the work area, but capped.
  // (Wave uses: width/height = workArea - 200, caps 2000x1200, mins 800x500)
  const { width: workAreaW, height: workAreaH } = screen.getPrimaryDisplay().workAreaSize
    width = Math.min(Math.max(workAreaW - 200, 800), 2000)
    height = Math.min(Math.max(workAreaH - 200, 500), 1200)
  }

  const platformWindowOptions = getPlatformBrowserWindowOptions(
    uiSettings.themeId,
    themeStore.getCustomThemes()
  )

  mainWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 800,
    minHeight: 500,
    ...platformWindowOptions,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Prevent Electron from using the sandboxed renderer bundle in dev.
      // This avoids a known class of startup console errors where the sandbox bundle fails early.
      sandbox: false
    }
  })

  // Load the app
  if (!app.isPackaged) {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (!devUrl) {
      throw new Error('Missing ELECTRON_RENDERER_URL (electron-vite dev server URL)')
    }
    mainWindow.loadURL(`${devUrl}/index.html`)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  applyPlatformWindowTweaks(mainWindow)

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Only allow http/https protocols for safety
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Check if the URL is different from the main window URL and is an external protocol
    if (url !== mainWindow?.webContents.getURL() && (url.startsWith('http:') || url.startsWith('https:'))) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  // Save window bounds on resize or move
  const saveBounds = () => {
    if (!mainWindow) return
    const bounds = mainWindow.getBounds()
    settingsService.setSettings({
      layout: {
        window: bounds
      }
    })
  }
  mainWindow.on('resize', saveBounds)
  mainWindow.on('move', saveBounds)
}

export async function startElectronMain(): Promise<void> {
  await app.whenReady()

  try {
    installCliLaunchers({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      projectRoot: resolve(__dirname, '../../../../')
    })
  } catch (error) {
    console.warn('[Main] Failed to install CLI launchers:', error)
  }

  // Run Electron-only data migrations before services consume persisted state.
  const settingsMigration = new ElectronAppSettingsMigration()
  settingsMigration.run()

  // Initialize services
  settingsService = new SettingsService()
  uiSettingsStore = new UiSettingsStore()
  const terminalStateStore = new TerminalStateStore(join(app.getPath('userData'), 'terminal-tabs-state.json'))
  terminalService = new TerminalService({
    terminalStateStore
  })
  fileSystemService = new FileSystemService(terminalService)
  commandPolicyService = new CommandPolicyService()
  mcpToolService = new McpToolService()
  themeStore = new ThemeConfigStore()
  uiHistoryService = new UIHistoryService()
  tempFileService = new TempFileService()
  imageAttachmentService = new ImageAttachmentService(app.getPath('userData'))
  versionService = new VersionService()
  accessTokenService = new AccessTokenService()

  await themeStore.loadCustomThemes()
  
  // Cleanup old pastes on startup
  void tempFileService.cleanup()

  // Ensure skills dir exists + initial scan (best-effort)
  skillService = new SkillService(settingsService)
  void skillService.reload()
  memoryService = new MemoryService()
  void memoryService.ensureMemoryFile()

  modelCapabilityService = new ModelCapabilityService()
  const chatHistoryService = new ChatHistoryService()
  agentService = new AgentService_v2(
    terminalService,
    commandPolicyService,
    mcpToolService,
    skillService,
    memoryService,
    uiHistoryService,
    chatHistoryService,
    imageAttachmentService
  )
  const gatewayService = new GatewayService(
    terminalService, 
    agentService, 
    uiHistoryService, 
    commandPolicyService, 
    settingsService,
    mcpToolService
  )
  const terminalRestoreResult = await terminalService.restorePersistedTerminals()
  if (terminalRestoreResult.restored.length > 0 || terminalRestoreResult.failed.length > 0) {
    console.log(
      `[Main] Terminal restore completed. restored=${terminalRestoreResult.restored.length} failed=${terminalRestoreResult.failed.length}`
    )
    if (terminalRestoreResult.failed.length > 0) {
      terminalRestoreResult.failed.forEach((item) => {
        console.warn(`[Main] Terminal restore failed for ${item.id}: ${item.reason}`)
      })
    }
  }
  gatewayService.registerTransport(new ElectronWindowTransport())
  webSocketGatewayControlService = new WebSocketGatewayControlService({
    createAdapter: (host, port) =>
      new WebSocketGatewayAdapter(gatewayService, {
        host,
        port,
        accessTokenAuth: {
          verifyToken: (token: string) => accessTokenService.verifyToken(token),
          allowLocalhostWithoutToken: true
        },
        terminalBridge: {
          listTerminals: () =>
            terminalService.getDisplayTerminals().map((terminal) => ({
              id: terminal.id,
              title: terminal.title,
              type: terminal.type,
              cols: terminal.cols,
              rows: terminal.rows,
              runtimeState: terminal.runtimeState,
              lastExitCode: terminal.lastExitCode
            })),
          createTab: async (config) => {
            const snapshot = terminalService.getDisplayTerminals()
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
            if (terminalService.getDisplayTerminals().length <= 1) {
              throw new Error('Cannot close the last terminal tab.')
            }
            terminalService.kill(terminalId)
          },
          setSelection: async (terminalId, selectionText) => {
            terminalService.setSelection(terminalId, selectionText)
          },
          getBufferDelta: async (terminalId, fromOffset) => {
            const data = terminalService.getBufferDelta(terminalId, fromOffset)
            const offset = terminalService.getCurrentOffset(terminalId)
            return { data, offset }
          }
        },
        filesystemBridge: {
          listDirectory: async (terminalId, dirPath) => {
            return await fileSystemService.listDirectory(terminalId, dirPath)
          },
          readTextFile: async (terminalId, filePath, options) => {
            return await fileSystemService.readTextFile(terminalId, filePath, options)
          },
          readFileBase64: async (terminalId, filePath, options) => {
            return await fileSystemService.readFileBase64(terminalId, filePath, options)
          },
          writeTextFile: async (terminalId, filePath, content) => {
            await fileSystemService.writeTextFile(terminalId, filePath, content)
          },
          writeFileBase64: async (terminalId, filePath, contentBase64, options) => {
            await fileSystemService.writeFileBase64(terminalId, filePath, contentBase64, options)
          },
          transferEntries: async (sourceTerminalId, sourcePaths, targetTerminalId, targetDirPath, options) => {
            return await fileSystemService.transferEntries(
              sourceTerminalId,
              sourcePaths,
              targetTerminalId,
              targetDirPath,
              options
            )
          },
          createDirectory: async (terminalId, dirPath) => {
            await fileSystemService.createDirectory(terminalId, dirPath)
          },
          createFile: async (terminalId, filePath) => {
            await fileSystemService.createFile(terminalId, filePath)
          },
          deletePath: async (terminalId, targetPath, options) => {
            await fileSystemService.deletePath(terminalId, targetPath, options)
          },
          renamePath: async (terminalId, sourcePath, targetPath) => {
            await fileSystemService.renamePath(terminalId, sourcePath, targetPath)
          }
        },
        profileBridge: {
          getProfiles: () => {
            const settingsSnapshot = settingsService.getSettings()
            const modelNameById = new Map(settingsSnapshot.models.items.map((model) => [model.id, model.model]))
            return {
              activeProfileId: settingsSnapshot.models.activeProfileId,
              profiles: settingsSnapshot.models.profiles.map((profile) => ({
                id: profile.id,
                name: profile.name,
                globalModelId: profile.globalModelId,
                modelName: modelNameById.get(profile.globalModelId)
              }))
            }
          },
          setActiveProfile: (profileId: string) => {
            const settingsSnapshot = settingsService.getSettings()
            const exists = settingsSnapshot.models.profiles.some((profile) => profile.id === profileId)
            if (!exists) {
              throw new Error(`Profile not found: ${profileId}`)
            }
            settingsService.setSettings({
              models: {
                items: settingsSnapshot.models.items,
                profiles: settingsSnapshot.models.profiles,
                activeProfileId: profileId
              }
            })
            const nextSettings = settingsService.getSettings()
            agentService.updateSettings(nextSettings)

            const modelNameById = new Map(nextSettings.models.items.map((model) => [model.id, model.model]))
            return {
              activeProfileId: nextSettings.models.activeProfileId,
              profiles: nextSettings.models.profiles.map((profile) => ({
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
            return await tempFileService.saveTempPaste(content)
          },
          saveImageAttachment: async (payload: {
            dataBase64: string
            fileName?: string
            mimeType?: string
            previewDataUrl?: string
          }) => {
            return await imageAttachmentService.saveImageAttachment(payload)
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
            const settingsSnapshot = settingsService.getSettings()
            const enabledMap = settingsSnapshot.tools?.skills ?? {}
            const skills = await skillService.getAll()
            return skills.map((skill) => ({
              name: skill.name,
              description: skill.description,
              enabled: enabledMap[skill.name] !== false
            }))
          },
          setSkillEnabled: async (name: string, enabled: boolean) => {
            const settingsSnapshot = settingsService.getSettings()
            const nextSkills = { ...(settingsSnapshot.tools?.skills ?? {}) }
            nextSkills[name] = enabled
            settingsService.setSettings({
              tools: { builtIn: settingsSnapshot.tools?.builtIn ?? {}, skills: nextSkills }
            })
            const nextSettings = settingsService.getSettings()
            agentService.updateSettings(nextSettings)

            const skills = await skillService.getAll()
            const summary = buildSkillStatusSummary(skills, nextSettings.tools?.skills)
            gatewayService.broadcastRaw('skills:updated', summary)
            return summary
          }
        },
        memoryBridge: {
          get: async () => {
            return await memoryService.getMemorySnapshot()
          },
          setContent: async (content: string) => {
            const snapshot = await memoryService.writeMemory(content)
            gatewayService.broadcastRaw('memory:updated', snapshot)
            return snapshot
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
            return buildBuiltInToolStatusSummary(settings.tools?.builtIn)
          },
          setBuiltInEnabled: async (name, enabled) => {
            const settings = settingsService.getSettings()
            const nextBuiltIn = { ...(settings.tools?.builtIn ?? {}) }
            nextBuiltIn[name] = enabled
            settingsService.setSettings({ tools: { builtIn: nextBuiltIn, skills: settings.tools?.skills ?? {} } })
            const next = settingsService.getSettings()
            agentService.updateSettings(next)
            const summary = buildBuiltInToolStatusSummary(next.tools?.builtIn)
            gatewayService.broadcastRaw('tools:builtInUpdated', summary)
            return summary
          }
        }
      })
  })
  const ipcAdapter = new ElectronGatewayIpcAdapter(
    gatewayService,
    terminalService,
    agentService,
    uiHistoryService,
    commandPolicyService,
    tempFileService,
    imageAttachmentService,
    skillService,
    memoryService,
    settingsService,
    uiSettingsStore,
    modelCapabilityService,
    mcpToolService,
    themeStore,
    versionService,
    webSocketGatewayControlService,
    accessTokenService,
    fileSystemService
  )
  ipcAdapter.registerHandlers()

  const settingsSnapshot = settingsService.getSettings()
  const startupPolicy = resolveWsGatewayPolicyFromEnv({
    env: process.env,
    defaultPolicy: {
      access: settingsSnapshot.gateway.ws.access,
      port: settingsSnapshot.gateway.ws.port
    },
    enableVarName: 'GYSHELL_WS_ENABLE',
    hostVarName: 'GYSHELL_WS_HOST',
    portVarName: 'GYSHELL_WS_PORT'
  })
  try {
    await webSocketGatewayControlService.applyPolicy(startupPolicy)
  } catch (error) {
    console.error('[Main] Failed to apply websocket gateway startup policy:', error)
  }

  // Load MCP tools (best-effort)
  void mcpToolService.reloadAll()

  // Update agent with current settings
  const settings = settingsService.getSettings()
  agentService.updateSettings(settings)

  // Create window
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
}

app.on('window-all-closed', async () => {
  if (terminalService) {
    terminalService.flushPersistedState()
  }
  if (webSocketGatewayControlService) {
    try {
      await webSocketGatewayControlService.stop()
    } catch (error) {
      console.error('[Main] Failed to stop websocket gateway server:', error)
    } finally {
      webSocketGatewayControlService = null
    }
  }
  if (tempFileService) {
    await tempFileService.cleanup()
  }
  app.quit()
})
