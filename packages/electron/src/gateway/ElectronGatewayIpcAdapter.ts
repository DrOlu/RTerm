import { ipcMain, shell, Menu, BrowserWindow } from 'electron'
import type { StartTaskOptions, IGatewayRuntime } from '../../../backend/src/services/Gateway/types'
import type { TerminalService } from '../../../backend/src/services/TerminalService'
import type { AgentService_v2 } from '../../../backend/src/services/AgentService_v2'
import type { UIHistoryService, HistoryExportMode } from '../../../backend/src/services/UIHistoryService'
import type { CommandPolicyService } from '../../../backend/src/services/CommandPolicy/CommandPolicyService'
import type { TempFileService } from '../../../backend/src/services/TempFileService'
import type { SkillService } from '../../../backend/src/services/SkillService'
import type { SettingsService } from '../../../backend/src/services/SettingsService'
import type { ModelCapabilityService } from '../../../backend/src/services/ModelCapabilityService'
import type { McpToolService } from '../../../backend/src/services/McpToolService'
import type { VersionService } from '../../../backend/src/services/VersionService'
import type { WsGatewayAccess } from '../../../backend/src/types'
import { BUILTIN_TOOL_INFO } from '../../../backend/src/services/AgentHelper/tools'
import { resolveTheme } from '../../../shared/src/theme/themes'
import type { WebSocketGatewayControlService } from '../../../backend/src/services/Gateway/WebSocketGatewayControlService'
import type { UiSettingsStore } from '../settings/UiSettingsStore'
import type { ThemeConfigStore } from '../theme/ThemeConfigStore'

export class ElectronGatewayIpcAdapter {
  constructor(
    private gateway: IGatewayRuntime,
    private terminalService: TerminalService,
    private agentService: AgentService_v2,
    private uiHistoryService: UIHistoryService,
    private commandPolicyService: CommandPolicyService,
    private tempFileService: TempFileService,
    private skillService: SkillService,
    private settingsService: SettingsService,
    private uiSettingsStore: UiSettingsStore,
    private modelCapabilityService: ModelCapabilityService,
    private mcpToolService: McpToolService,
    private themeStore: ThemeConfigStore,
    private versionService: VersionService,
    private wsGatewayControlService: WebSocketGatewayControlService
  ) {}

  private updateWindowsThemeIfNeeded(): void {
    if (process.platform !== 'win32') return
    const uiSettings = this.uiSettingsStore.getSettings()
    const theme = resolveTheme(uiSettings.themeId, this.themeStore.getCustomThemes())
    const bg = theme.terminal.background
    const fg = theme.terminal.foreground
    const windows = BrowserWindow.getAllWindows()
    windows.forEach((win) => {
      if (typeof win.setTitleBarOverlay === 'function') {
        win.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 38 })
        win.setBackgroundColor(bg)
      }
    })
  }

  registerHandlers(): void {
    // Agent runtime
    ipcMain.handle(
      'agent:startTask',
      async (_: any, sessionId: string, userText: string, options?: StartTaskOptions) => {
        return this.gateway.dispatchTask(sessionId, userText, options)
      }
    )

    ipcMain.handle('agent:stopTask', async (_: any, sessionId: string) => {
      return this.gateway.stopTask(sessionId)
    })

    ipcMain.handle('agent:replyMessage', async (_: any, messageId: string, payload: any) => {
      console.log(`[ElectronGatewayIpcAdapter] Received replyMessage for messageId=${messageId}:`, payload)
      return this.gateway.submitFeedback(messageId, payload)
    })

    ipcMain.handle('agent:replyCommandApproval', async (_: any, approvalId: string, decision: 'allow' | 'deny') => {
      return this.gateway.submitFeedback(approvalId, { decision })
    })

    ipcMain.handle('agent:deleteChatSession', async (_: any, sessionId: string) => {
      await this.gateway.deleteChatSession(sessionId)
    })

    ipcMain.handle('agent:renameSession', async (_: any, sessionId: string, newTitle: string) => {
      this.gateway.renameSession(sessionId, newTitle)
    })

    ipcMain.handle('agent:exportHistory', async (_: any, sessionId: string, mode: HistoryExportMode = 'detailed') => {
      await this.gateway.waitForRunCompletion(sessionId)
      const backendSession = this.agentService.exportChatSession(sessionId)
      if (!backendSession) {
        throw new Error(`Session with ID ${sessionId} not found`)
      }
      const uiSession = this.uiHistoryService.getSession(sessionId)

      const safeFileBaseName = (input: string): string => {
        const raw = String(input || '').trim()
        const cleaned = raw
          .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
          .replace(/\s+/g, ' ')
          .trim()
        const normalized = cleaned.replace(/^[. ]+|[. ]+$/g, '')
        return normalized || 'conversation'
      }

      const formatTimestamp = (d: Date): string => {
        const pad = (n: number) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
      }

      const { dialog } = require('electron')
      const baseName = safeFileBaseName(uiSession?.title || backendSession.title)
      const ts = formatTimestamp(new Date())
      const isSimple = mode === 'simple'
      const { filePath } = await dialog.showSaveDialog({
        title: isSimple ? 'Export Conversation (Markdown)' : 'Export Conversation History',
        defaultPath: isSimple ? `${baseName}_${ts}.md` : `${baseName}_${ts}.json`,
        filters: isSimple
          ? [
              { name: 'Markdown', extensions: ['md'] },
              { name: 'All Files', extensions: ['*'] }
            ]
          : [
              { name: 'JSON', extensions: ['json'] },
              { name: 'All Files', extensions: ['*'] }
            ]
      })

      if (filePath) {
        const fs = require('fs')
        if (isSimple) {
          const markdown = this.uiHistoryService.toReadableMarkdown(
            uiSession?.messages || [],
            uiSession?.title || backendSession.title
          )
          await fs.promises.writeFile(filePath, markdown, 'utf8')
        } else {
          const historyToExport = {
            sessionId: backendSession.id,
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
          await fs.promises.writeFile(filePath, JSON.stringify(historyToExport, null, 2))
        }
      }
    })

    ipcMain.handle('agent:getAllChatHistory', () => this.agentService.getAllChatHistory())
    ipcMain.handle('agent:loadChatSession', (_: any, id: string) => this.agentService.loadChatSession(id))
    ipcMain.handle('agent:getUiMessages', (_: any, id: string) => this.uiHistoryService.getMessages(id))
    ipcMain.handle('agent:rollbackToMessage', async (_: any, sessionId: string, messageId: string) => {
      return this.gateway.rollbackSessionToMessage(sessionId, messageId)
    })

    // System / temp
    ipcMain.handle('system:saveTempPaste', async (_: any, content: string) => {
      return await this.tempFileService.saveTempPaste(content)
    })

    ipcMain.handle('system:openExternal', async (_: any, url: string) => {
      if (url && (url.startsWith('http:') || url.startsWith('https:'))) {
        await shell.openExternal(url)
      }
    })

    // Skills
    ipcMain.handle('skills:openFolder', async () => {
      await this.skillService.openSkillsFolder()
    })

    ipcMain.handle('skills:reload', async () => {
      return await this.skillService.reload()
    })

    ipcMain.handle('skills:getAll', async () => {
      return await this.skillService.getAll()
    })

    ipcMain.handle('skills:getEnabled', async () => {
      return await this.skillService.getEnabledSkills()
    })

    ipcMain.handle('skills:create', async () => {
      return await this.skillService.createSkillFromTemplate()
    })

    ipcMain.handle('skills:openFile', async (_evt: any, fileName: string) => {
      await this.skillService.openSkillFile(fileName)
    })

    ipcMain.handle('skills:delete', async (_evt: any, fileName: string) => {
      await this.skillService.deleteSkillFile(fileName)
      return await this.skillService.getAll()
    })

    ipcMain.handle('skills:setEnabled', async (_: any, name: string, enabled: boolean) => {
      const settings = this.settingsService.getSettings()
      const nextSkills = { ...(settings.tools?.skills ?? {}) }
      nextSkills[name] = enabled
      this.settingsService.setSettings({
        tools: { builtIn: settings.tools?.builtIn ?? {}, skills: nextSkills }
      })
      this.agentService.updateSettings(this.settingsService.getSettings())

      const enabledSkills = await this.skillService.getEnabledSkills()
      this.gateway.broadcastRaw('skills:updated', enabledSkills)
      return enabledSkills
    })

    // Settings / tools / themes / models
    ipcMain.handle('settings:get', async () => {
      return this.settingsService.getSettings()
    })

    ipcMain.handle('settings:set', async (_: any, settings: any) => {
      if (settings?.gateway?.ws) {
        await this.applyWsGatewayConfig(settings.gateway.ws)
      }
      this.settingsService.setSettings(settings)
      const currentSettings = this.settingsService.getSettings()
      this.agentService.updateSettings(currentSettings)
    })

    ipcMain.handle('settings:setWsGatewayAccess', async (_: any, access: WsGatewayAccess) => {
      const current = this.settingsService.getSettings()
      return this.applyWsGatewayConfig({
        access,
        port: current.gateway.ws.port
      })
    })

    ipcMain.handle('settings:setWsGatewayConfig', async (_: any, ws: { access: WsGatewayAccess; port: number }) => {
      return this.applyWsGatewayConfig(ws)
    })

    ipcMain.handle('ui-settings:get', async () => {
      return this.uiSettingsStore.getSettings()
    })

    ipcMain.handle('ui-settings:set', async (_: any, settings: any) => {
      this.uiSettingsStore.setSettings(settings)
      this.updateWindowsThemeIfNeeded()
    })

    ipcMain.handle('models:probe', async (_evt: any, model: any) => {
      return await this.modelCapabilityService.probe(model)
    })

    ipcMain.handle('settings:openCommandPolicyFile', async () => {
      await this.commandPolicyService.openPolicyFile()
    })

    ipcMain.handle('settings:getCommandPolicyLists', async () => {
      return await this.commandPolicyService.getLists()
    })

    ipcMain.handle(
      'settings:addCommandPolicyRule',
      async (_evt: any, listName: 'allowlist' | 'denylist' | 'asklist', rule: string) => {
        return await this.commandPolicyService.addRule(listName, rule)
      }
    )

    ipcMain.handle(
      'settings:deleteCommandPolicyRule',
      async (_evt: any, listName: 'allowlist' | 'denylist' | 'asklist', rule: string) => {
        return await this.commandPolicyService.deleteRule(listName, rule)
      }
    )

    ipcMain.handle('tools:openMcpConfig', async () => {
      await this.mcpToolService.openConfigFile()
    })

    ipcMain.handle('tools:reloadMcp', async () => {
      return await this.mcpToolService.reloadAll()
    })

    ipcMain.handle('tools:getMcp', async () => {
      return this.mcpToolService.getSummaries()
    })

    ipcMain.handle('tools:setMcpEnabled', async (_: any, name: string, enabled: boolean) => {
      return await this.mcpToolService.setServerEnabled(name, enabled)
    })

    ipcMain.handle('tools:getBuiltIn', async () => {
      const settings = this.settingsService.getSettings()
      const enabledMap = settings.tools?.builtIn ?? {}
      return BUILTIN_TOOL_INFO.map((tool) => ({
        name: tool.name,
        description: tool.description,
        enabled: enabledMap[tool.name] ?? true
      }))
    })

    ipcMain.handle('tools:setBuiltInEnabled', async (_: any, name: string, enabled: boolean) => {
      const settings = this.settingsService.getSettings()
      const nextBuiltIn = { ...(settings.tools?.builtIn ?? {}) }
      nextBuiltIn[name] = enabled
      this.settingsService.setSettings({ tools: { builtIn: nextBuiltIn, skills: settings.tools?.skills ?? {} } })
      this.agentService.updateSettings(this.settingsService.getSettings())
      return BUILTIN_TOOL_INFO.map((tool) => ({
        name: tool.name,
        description: tool.description,
        enabled: nextBuiltIn[tool.name] ?? true
      }))
    })

    ipcMain.handle('themes:openCustomConfig', async () => {
      await this.themeStore.openCustomThemeFile()
    })

    ipcMain.handle('themes:reloadCustom', async () => {
      const themes = await this.themeStore.loadCustomThemes()
      this.updateWindowsThemeIfNeeded()
      return themes
    })

    ipcMain.handle('themes:getCustom', async () => {
      return await this.themeStore.loadCustomThemes()
    })

    ipcMain.handle('version:getState', async () => {
      return this.versionService.getState()
    })

    ipcMain.handle('version:check', async () => {
      return await this.versionService.checkForUpdates()
    })

    // Terminal
    ipcMain.handle('terminal:createTab', async (_: any, config: any) => {
      const tab = await this.terminalService.createTerminal(config)
      return { id: tab.id }
    })

    ipcMain.handle('terminal:write', async (_: any, terminalId: string, data: string) => {
      this.terminalService.write(terminalId, data)
    })

    ipcMain.handle('terminal:writePaths', async (_: any, terminalId: string, paths: string[]) => {
      this.terminalService.writePaths(terminalId, paths)
    })

    ipcMain.handle('terminal:resize', async (_: any, terminalId: string, cols: number, rows: number) => {
      this.terminalService.resize(terminalId, cols, rows)
    })

    ipcMain.handle('terminal:kill', async (_: any, terminalId: string) => {
      this.terminalService.kill(terminalId)
    })

    ipcMain.handle('terminal:setSelection', async (_: any, terminalId: string, selectionText: string) => {
      this.terminalService.setSelection(terminalId, selectionText)
    })

    // UI
    ipcMain.handle(
      'ui:showContextMenu',
      async (event: any, payload: { id: string; canCopy: boolean; canPaste: boolean }) => {
        const window = BrowserWindow.fromWebContents(event.sender)
        if (!window) return

        const menu = Menu.buildFromTemplate([
          {
            label: 'Copy',
            enabled: payload.canCopy,
            click: () => {
              window.webContents.send('ui:contextMenuAction', { id: payload.id, action: 'copy' })
            }
          },
          {
            label: 'Paste',
            enabled: payload.canPaste,
            click: () => {
              window.webContents.send('ui:contextMenuAction', { id: payload.id, action: 'paste' })
            }
          }
        ])

        menu.popup({ window })
      }
    )
  }

  private async applyWsGatewayConfig(ws: { access: WsGatewayAccess; port: number }) {
    if (ws.access !== 'disabled' && ws.access !== 'localhost' && ws.access !== 'internet') {
      throw new Error(`Invalid websocket gateway access mode: ${String(ws.access)}`)
    }
    const port = Number(ws.port)
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
      throw new Error(`Invalid websocket gateway port: ${String(ws.port)}`)
    }
    const nextWs = {
      access: ws.access,
      port
    }
    await this.wsGatewayControlService.applyPolicy(nextWs)
    this.settingsService.setSettings({
      gateway: {
        ws: nextWs
      }
    })
    const nextSettings = this.settingsService.getSettings()
    this.agentService.updateSettings(nextSettings)
    return nextSettings.gateway.ws
  }
}
