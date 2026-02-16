import { action, computed, makeObservable, observable, runInAction, toJS } from 'mobx'
import { v4 as uuidv4 } from 'uuid'
import type { ITheme } from '@xterm/xterm'
import type { AppSettings, TerminalConfig, AppLanguage, ModelDefinition, ProxyEntry, TunnelEntry } from '../lib/ipcTypes'
import { applyAppThemeFromTerminalScheme } from '../theme/appTheme'
import { resolveTheme } from '../theme/themes'
import { toXtermTheme } from '../theme/xtermTheme'
import type { TerminalColorScheme } from '../theme/terminalColorSchemes'
import { I18nStore } from './I18nStore'
import { ChatStore } from './ChatStore'
import { LayoutStore } from './LayoutStore'

const upsertById = <T extends { id: string }>(list: T[], entry: T): T[] => {
  const idx = list.findIndex((x) => x.id === entry.id)
  if (idx === -1) return [...list, entry]
  const next = list.slice()
  next[idx] = entry
  return next
}

const removeById = <T extends { id: string }>(list: T[], id: string): T[] =>
  list.filter((x) => x.id !== id)

export type AppView = 'main' | 'settings' | 'connections'
export type SettingsSection = 'general' | 'theme' | 'models' | 'security' | 'tools' | 'skills' | 'version'

export type McpToolSummary = Awaited<ReturnType<Window['gyshell']['tools']['getMcp']>>[number]
export type BuiltInToolSummary = Awaited<ReturnType<Window['gyshell']['tools']['getBuiltIn']>>[number]
export type SkillSummary = Awaited<ReturnType<Window['gyshell']['skills']['getAll']>>[number]
export type SkillStatusSummary = Awaited<ReturnType<Window['gyshell']['skills']['setEnabled']>>[number]
export type CommandPolicyLists = Awaited<ReturnType<Window['gyshell']['settings']['getCommandPolicyLists']>>
export type VersionCheckResult = Awaited<ReturnType<Window['gyshell']['version']['check']>>

export interface TerminalTabModel {
  id: string
  title: string
  config: TerminalConfig
  connectionRef?: { type: 'local' } | { type: 'ssh'; entryId: string }
}
type TerminalListPayload = Awaited<ReturnType<Window['gyshell']['terminal']['list']>>

export class AppStore {
  view: AppView = 'main'
  settings: AppSettings | null = null
  isBootstrapped = false
  settingsSection: SettingsSection = 'general'

  terminalTabs: TerminalTabModel[] = []
  activeTerminalId: string | null = null
  terminalSelections: Record<string, string> = {}

  xtermTheme: ITheme = {}
  customThemes: TerminalColorScheme[] = []
  i18n = new I18nStore()
  chat = new ChatStore()
  layout = new LayoutStore(this)
  mcpTools: McpToolSummary[] = []
  builtInTools: BuiltInToolSummary[] = []
  skills: SkillSummary[] = []
  commandPolicyLists: CommandPolicyLists = { allowlist: [], denylist: [], asklist: [] }
  versionInfo: VersionCheckResult | null = null
  versionCheckInProgress = false
  showVersionUpdateDialog = false

  constructor() {
    makeObservable(this, {
      view: observable,
      settings: observable,
      isBootstrapped: observable,
      settingsSection: observable,
      terminalTabs: observable,
      activeTerminalId: observable,
      terminalSelections: observable,
      xtermTheme: observable,
      customThemes: observable,
      i18n: observable,
      chat: observable,
      layout: observable,
      mcpTools: observable,
      builtInTools: observable,
      skills: observable,
      commandPolicyLists: observable,
      versionInfo: observable,
      versionCheckInProgress: observable,
      showVersionUpdateDialog: observable,
      isSettings: computed,
      isConnections: computed,
      activeTerminal: computed,
      openSettings: action,
      closeSettings: action,
      toggleSettings: action,
      openConnections: action,
      closeOverlay: action,
      bootstrap: action,
      createLocalTab: action,
      createSshTab: action,
      saveSshConnection: action,
      deleteSshConnection: action,
      closeTab: action,
      setActiveTerminal: action,
      setTerminalSelection: action,
      setSettingsSection: action,
      setThemeId: action,
      setLanguage: action,
      setTerminalSettings: action,
      saveModel: action,
      deleteModel: action,
      saveProfile: action,
      deleteProfile: action,
      setActiveProfile: action,
      saveProxy: action,
      deleteProxy: action,
      saveTunnel: action,
      deleteTunnel: action,
      setCommandPolicyMode: action,
      openCommandPolicyFile: action,
      loadCommandPolicyLists: action,
      addCommandPolicyRule: action,
      deleteCommandPolicyRule: action,
      loadTools: action,
      loadSkills: action,
      openSkillsFolder: action,
      reloadSkills: action,
      createSkill: action,
      editSkill: action,
      deleteSkill: action,
      openCustomThemeFile: action,
      reloadCustomThemes: action,
      openMcpConfig: action,
      reloadMcpTools: action,
      setMcpToolEnabled: action,
      setBuiltInToolEnabled: action,
      setSkillEnabled: action,
      setRecursionLimit: action,
      setDebugMode: action,
      setWsGatewayAccess: action,
      setWsGatewayPort: action,
      setRuntimeThinkingCorrectionEnabled: action,
      setTaskFinishGuardEnabled: action,
      setFirstTurnThinkingModelEnabled: action,
      sendChatMessage: action,
      getUniqueTitle: action,
      loadVersionState: action,
      checkVersion: action,
      closeVersionUpdateDialog: action,
      openVersionDownload: action,
      reconcileTerminalTabs: action
    })
    this.chat.setQueueRunner((sessionId, content) => this.sendChatMessage(sessionId, content, { mode: 'queue' }))
  }

  getUniqueTitle(baseTitle: string): string {
    const existingTitles = this.terminalTabs.map((t) => t.title)
    if (!existingTitles.includes(baseTitle)) {
      return baseTitle
    }

    let counter = 1
    let newTitle = `${baseTitle} (${counter})`
    while (existingTitles.includes(newTitle)) {
      counter++
      newTitle = `${baseTitle} (${counter})`
    }
    return newTitle
  }

  get isSettings(): boolean {
    return this.view === 'settings'
  }

  get isConnections(): boolean {
    return this.view === 'connections'
  }

  get activeTerminal(): TerminalTabModel | null {
    if (!this.activeTerminalId) return null
    return this.terminalTabs.find((t) => t.id === this.activeTerminalId) ?? null
  }

  private toTerminalConfig(item: {
    id: string
    title: string
    type: TerminalConfig['type']
    cols: number
    rows: number
  }): TerminalConfig {
    return {
      type: item.type,
      id: item.id,
      title: item.title,
      cols: item.cols > 0 ? item.cols : 80,
      rows: item.rows > 0 ? item.rows : 24
    } as TerminalConfig
  }

  reconcileTerminalTabs(payload: TerminalListPayload): void {
    const incoming = payload?.terminals || []
    const existingById = new Map(this.terminalTabs.map((tab) => [tab.id, tab]))
    const nextTabs: TerminalTabModel[] = incoming.map((item) => {
      const existing = existingById.get(item.id)
      if (existing) {
        return {
          ...existing,
          title: item.title,
          config: {
            ...existing.config,
            title: item.title,
            cols: item.cols > 0 ? item.cols : existing.config.cols,
            rows: item.rows > 0 ? item.rows : existing.config.rows
          }
        }
      }
      return {
        id: item.id,
        title: item.title,
        config: this.toTerminalConfig(item),
        connectionRef: item.type === 'local' ? { type: 'local' } : undefined
      }
    })

    let nextActive = this.activeTerminalId
    if (!nextActive || !nextTabs.some((tab) => tab.id === nextActive)) {
      nextActive = nextTabs[0]?.id || null
    }

    this.terminalTabs = nextTabs
    this.activeTerminalId = nextActive
  }

  private async fetchCombinedSettings(): Promise<AppSettings> {
    const [backendSettings, uiSettings] = await Promise.all([
      window.gyshell.settings.get(),
      window.gyshell.uiSettings.get()
    ])
    return {
      ...backendSettings,
      ...uiSettings
    }
  }

  private applySkillStatusUpdate(updates: SkillStatusSummary[]): void {
    const enabledByName = new Map<string, boolean>()
    updates.forEach((item) => {
      if (!item?.name) return
      enabledByName.set(item.name, item.enabled !== false)
    })
    if (enabledByName.size === 0) return

    this.skills = this.skills.map((skill) =>
      enabledByName.has(skill.name)
        ? {
            ...skill,
            enabled: enabledByName.get(skill.name)
          }
        : skill
    )

    if (!this.settings) return
    const nextToolsSkills = { ...(this.settings.tools?.skills ?? {}) }
    enabledByName.forEach((enabled, name) => {
      nextToolsSkills[name] = enabled
    })
    this.settings = {
      ...this.settings,
      tools: {
        builtIn: this.settings.tools?.builtIn ?? {},
        skills: nextToolsSkills
      }
    }
  }

  private applyBuiltInToolStatusUpdate(tools: BuiltInToolSummary[]): void {
    this.builtInTools = tools
    if (!this.settings) return
    const nextToolsBuiltIn = { ...(this.settings.tools?.builtIn ?? {}) }
    tools.forEach((tool) => {
      nextToolsBuiltIn[tool.name] = tool.enabled
    })
    this.settings = {
      ...this.settings,
      tools: {
        builtIn: nextToolsBuiltIn,
        skills: this.settings.tools?.skills ?? {}
      }
    }
  }

  openSettings(): void {
    this.view = 'settings'
  }

  closeSettings(): void {
    this.view = 'main'
  }

  toggleSettings(): void {
    this.view = this.view === 'settings' ? 'main' : 'settings'
  }

  openConnections(): void {
    this.view = 'connections'
  }

  closeOverlay(): void {
    this.view = 'main'
  }

  setSettingsSection(section: SettingsSection): void {
    this.settingsSection = section
  }

  async loadVersionState(): Promise<void> {
    try {
      const state = await window.gyshell.version.getState()
      runInAction(() => {
        this.versionInfo = state
      })
    } catch (err) {
      console.error('Failed to load version state', err)
    }
  }

  async checkVersion(options?: { showPopupOnVersionChange?: boolean }): Promise<void> {
    if (this.versionCheckInProgress) return
    runInAction(() => {
      this.versionCheckInProgress = true
    })
    try {
      const result = await window.gyshell.version.check()
      runInAction(() => {
        this.versionInfo = result
        const hasVersionDifference =
          result.status !== 'error' &&
          typeof result.latestVersion === 'string' &&
          result.latestVersion.length > 0 &&
          result.latestVersion !== result.currentVersion
        const shouldShowPopup = options?.showPopupOnVersionChange ?? true
        if (hasVersionDifference && shouldShowPopup) {
          this.showVersionUpdateDialog = true
        }
      })
    } catch (err) {
      console.error('Failed to check version', err)
    } finally {
      runInAction(() => {
        this.versionCheckInProgress = false
      })
    }
  }

  closeVersionUpdateDialog(): void {
    this.showVersionUpdateDialog = false
  }

  async openVersionDownload(): Promise<void> {
    const url = this.versionInfo?.downloadUrl
    if (!url) return
    await window.gyshell.system.openExternal(url)
  }

  async setLanguage(lang: AppLanguage): Promise<void> {
    this.i18n.setLocale(lang)
    runInAction(() => {
      if (this.settings) {
        this.settings = { ...this.settings, language: lang }
      }
    })
    await window.gyshell.uiSettings.set({ language: lang })
  }

  async setTerminalSettings(terminal: Partial<AppSettings['terminal']>): Promise<void> {
    let nextTerminal: AppSettings['terminal'] | undefined
    runInAction(() => {
      if (this.settings) {
        this.settings.terminal = {
          ...this.settings.terminal,
          ...terminal
        }
        nextTerminal = toJS(this.settings.terminal)
      }
    })
    if (nextTerminal) {
      await window.gyshell.uiSettings.set({ terminal: nextTerminal })
    }
  }

  async setThemeId(themeId: string): Promise<void> {
    // optimistic UI: apply immediately
    const theme = resolveTheme(themeId, this.customThemes)
    applyAppThemeFromTerminalScheme(theme.terminal)
    const xtermTheme = toXtermTheme(theme.terminal, { transparentBackground: true })
    runInAction(() => {
      this.xtermTheme = xtermTheme
      if (this.settings) {
        this.settings = { ...this.settings, themeId }
      }
    })

    try {
      await window.gyshell.uiSettings.set({ themeId })
    } catch (err) {
      console.error('Failed to persist themeId', err)
      // best-effort rollback by reloading
      try {
        const [backendSettings, uiSettings] = await Promise.all([
          window.gyshell.settings.get(),
          window.gyshell.uiSettings.get()
        ])
        const settings = {
          ...backendSettings,
          ...uiSettings
        }
        const t = resolveTheme(settings.themeId, this.customThemes)
        applyAppThemeFromTerminalScheme(t.terminal)
        runInAction(() => {
          this.settings = settings
          this.xtermTheme = toXtermTheme(t.terminal, { transparentBackground: true })
        })
      } catch {
        // ignore
      }
    }
  }

  async setCommandPolicyMode(mode: AppSettings['commandPolicyMode']): Promise<void> {
    runInAction(() => {
      if (this.settings) {
        this.settings = { ...this.settings, commandPolicyMode: mode }
      }
    })
    await window.gyshell.settings.set({ commandPolicyMode: mode })
  }

  async openCommandPolicyFile(): Promise<void> {
    await window.gyshell.settings.openCommandPolicyFile()
  }

  async loadCommandPolicyLists(): Promise<void> {
    try {
      const lists = await window.gyshell.settings.getCommandPolicyLists()
      runInAction(() => {
        this.commandPolicyLists = lists
      })
    } catch (err) {
      console.error('Failed to load command policy lists', err)
    }
  }

  async addCommandPolicyRule(listName: 'allowlist' | 'denylist' | 'asklist', rule: string): Promise<void> {
    const lists = await window.gyshell.settings.addCommandPolicyRule(listName, rule)
    runInAction(() => {
      this.commandPolicyLists = lists
    })
  }

  async deleteCommandPolicyRule(listName: 'allowlist' | 'denylist' | 'asklist', rule: string): Promise<void> {
    const lists = await window.gyshell.settings.deleteCommandPolicyRule(listName, rule)
    runInAction(() => {
      this.commandPolicyLists = lists
    })
  }

  async loadTools(): Promise<void> {
    try {
      const [mcpTools, builtInTools] = await Promise.all([
        window.gyshell.tools.getMcp(),
        window.gyshell.tools.getBuiltIn()
      ])
      runInAction(() => {
        this.mcpTools = mcpTools
        this.builtInTools = builtInTools
      })
    } catch (err) {
      console.error('Failed to load tools status', err)
    }
  }

  async loadSkills(): Promise<void> {
    try {
      const [skills, enabledSkills, settings] = await Promise.all([
        window.gyshell.skills.getAll(),
        window.gyshell.skills.getEnabled(),
        this.fetchCombinedSettings()
      ])
      const enabledByName = new Set(enabledSkills.map((skill) => skill.name))
      runInAction(() => {
        this.settings = settings
        this.skills = skills.map((skill) => ({
          ...skill,
          enabled: enabledByName.has(skill.name)
        }))
      })
    } catch (err) {
      console.error('Failed to load skills', err)
    }
  }

  async openSkillsFolder(): Promise<void> {
    await window.gyshell.skills.openFolder()
  }

  async reloadSkills(): Promise<void> {
    const [skills, enabledSkills, settings] = await Promise.all([
      window.gyshell.skills.reload(),
      window.gyshell.skills.getEnabled(),
      this.fetchCombinedSettings()
    ])
    const enabledByName = new Set(enabledSkills.map((skill) => skill.name))
    runInAction(() => {
      this.settings = settings
      this.skills = skills.map((skill) => ({
        ...skill,
        enabled: enabledByName.has(skill.name)
      }))
    })
  }

  async createSkill(): Promise<void> {
    await window.gyshell.skills.create()
    await this.reloadSkills()
  }

  async editSkill(fileName: string): Promise<void> {
    await window.gyshell.skills.openFile(fileName)
  }

  async deleteSkill(fileName: string): Promise<void> {
    const skills = await window.gyshell.skills.delete(fileName)
    runInAction(() => {
      this.skills = skills
    })
  }

  async openMcpConfig(): Promise<void> {
    await window.gyshell.tools.openMcpConfig()
  }

  async reloadMcpTools(): Promise<void> {
    const mcpTools = await window.gyshell.tools.reloadMcp()
    runInAction(() => {
      this.mcpTools = mcpTools
    })
  }

  async setMcpToolEnabled(name: string, enabled: boolean): Promise<void> {
    const mcpTools = await window.gyshell.tools.setMcpEnabled(name, enabled)
    runInAction(() => {
      this.mcpTools = mcpTools
    })
  }

  async setBuiltInToolEnabled(name: string, enabled: boolean): Promise<void> {
    const builtInTools = await window.gyshell.tools.setBuiltInEnabled(name, enabled)
    runInAction(() => {
      this.applyBuiltInToolStatusUpdate(builtInTools)
    })
  }

  async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
    const skills = await window.gyshell.skills.setEnabled(name, enabled)
    const settings = await this.fetchCombinedSettings()
    runInAction(() => {
      this.settings = settings
      this.applySkillStatusUpdate(skills)
    })
  }

  async setRecursionLimit(limit: number): Promise<void> {
    runInAction(() => {
      if (this.settings) {
        this.settings.recursionLimit = limit
      }
    })
    await window.gyshell.settings.set({ recursionLimit: limit })
  }

  async setDebugMode(enabled: boolean): Promise<void> {
    runInAction(() => {
      if (this.settings) {
        this.settings.debugMode = enabled
      }
    })
    await window.gyshell.settings.set({ debugMode: enabled })
  }

  private async updateWsGatewaySettings(nextWs: NonNullable<AppSettings['gateway']>['ws']): Promise<void> {
    const previous = this.settings?.gateway?.ws
    runInAction(() => {
      if (this.settings) {
        this.settings.gateway = {
          ws: nextWs
        }
      }
    })
    try {
      const next = await window.gyshell.settings.setWsGatewayConfig(nextWs)
      runInAction(() => {
        if (this.settings) {
          this.settings.gateway = { ws: next }
        }
      })
    } catch (error) {
      runInAction(() => {
        if (this.settings && previous) {
          this.settings.gateway = { ws: previous }
        }
      })
      console.error('Failed to update websocket gateway settings', error)
    }
  }

  async setWsGatewayAccess(access: NonNullable<AppSettings['gateway']>['ws']['access']): Promise<void> {
    const current = this.settings?.gateway?.ws || { access: 'localhost', port: 17888 }
    await this.updateWsGatewaySettings({
      access,
      port: current.port
    })
  }

  async setWsGatewayPort(port: number): Promise<void> {
    const current = this.settings?.gateway?.ws || { access: 'localhost', port: 17888 }
    const rounded = Math.floor(port)
    if (!Number.isInteger(rounded) || rounded <= 0 || rounded >= 65536) {
      return
    }
    await this.updateWsGatewaySettings({
      access: current.access,
      port: rounded
    })
  }

  private getExperimentalSettingsSnapshot(): NonNullable<AppSettings['experimental']> {
    return {
      runtimeThinkingCorrectionEnabled:
        this.settings?.experimental?.runtimeThinkingCorrectionEnabled !== false,
      taskFinishGuardEnabled: this.settings?.experimental?.taskFinishGuardEnabled !== false,
      firstTurnThinkingModelEnabled: this.settings?.experimental?.firstTurnThinkingModelEnabled === true
    }
  }

  private async updateExperimentalSettings(
    patch: Partial<NonNullable<AppSettings['experimental']>>
  ): Promise<void> {
    const next = {
      ...this.getExperimentalSettingsSnapshot(),
      ...patch
    }
    runInAction(() => {
      if (this.settings) {
        this.settings.experimental = next
      }
    })
    await window.gyshell.settings.set({
      experimental: next
    })
  }

  async setRuntimeThinkingCorrectionEnabled(enabled: boolean): Promise<void> {
    await this.updateExperimentalSettings({
      runtimeThinkingCorrectionEnabled: enabled
    })
  }

  async setTaskFinishGuardEnabled(enabled: boolean): Promise<void> {
    await this.updateExperimentalSettings({
      taskFinishGuardEnabled: enabled
    })
  }

  async setFirstTurnThinkingModelEnabled(enabled: boolean): Promise<void> {
    await this.updateExperimentalSettings({
      firstTurnThinkingModelEnabled: enabled
    })
  }

  async openCustomThemeFile(): Promise<void> {
    await window.gyshell.themes.openCustomConfig()
  }

  async reloadCustomThemes(): Promise<void> {
    const themes = await window.gyshell.themes.reloadCustom()
    runInAction(() => {
      this.customThemes = themes
    })
    this.ensureThemeExists()
  }

  async bootstrap(): Promise<void> {
    if (this.isBootstrapped) return
    try {
      const [backendSettings, uiSettings, customThemes] = await Promise.all([
        window.gyshell.settings.get(),
        window.gyshell.uiSettings.get(),
        window.gyshell.themes.getCustom()
      ])
      const settings = {
        ...backendSettings,
        ...uiSettings
      }
      const theme = resolveTheme(settings.themeId, customThemes)
      applyAppThemeFromTerminalScheme(theme.terminal)
      const xtermTheme = toXtermTheme(theme.terminal, { transparentBackground: true })

      runInAction(() => {
        this.settings = settings
        this.xtermTheme = xtermTheme
        this.isBootstrapped = true
        this.i18n.setLocale(settings.language)
        this.customThemes = customThemes
        this.layout.bootstrap()
      })

      // Setup deterministic UI update listener (backend is the source of truth)
      window.gyshell.agent.onUiUpdate((action) => {
        this.chat.handleUiUpdate(action)
      })

      // Setup Terminal Exit Listener
      window.gyshell.terminal.onExit(({ terminalId }) => {
        // Only automatically close tab if it's NOT in initializing state.
        // If it was initializing (e.g. SSH connecting), we want to keep it open
        // so the user can see the error message.
        const tab = this.terminalTabs.find(t => t.id === terminalId)
        // Note: We can't easily check backend state here without a sync call,
        // but we can assume if it's an SSH tab that just failed, we should keep it.
        // A better way is to let the user manually close failed connections.
        if (tab && tab.config.type === 'local') {
          this.closeTab(terminalId)
        }
      })

      window.gyshell.terminal.onTabsUpdated((payload) => {
        runInAction(() => {
          this.reconcileTerminalTabs(payload)
        })
      })

      // MCP tool status updates
      window.gyshell.tools.onMcpUpdated((mcpTools) => {
        runInAction(() => {
          this.mcpTools = mcpTools
        })
      })

      window.gyshell.tools.onBuiltInUpdated((tools) => {
        runInAction(() => {
          this.applyBuiltInToolStatusUpdate(tools)
        })
      })

      // Skill status updates
      window.gyshell.skills.onUpdated((skills) => {
        runInAction(() => {
          this.applySkillStatusUpdate(skills)
        })
      })

      const terminalSnapshot = await window.gyshell.terminal.list()
      runInAction(() => {
        this.reconcileTerminalTabs(terminalSnapshot)
      })
      if (terminalSnapshot.terminals.length === 0) {
        this.createLocalTab()
      }

      // Load tools status
      void this.loadTools()
      void this.loadSkills()
      void this.loadCommandPolicyLists()
      void this.loadVersionState()
      void this.checkVersion({ showPopupOnVersionChange: true })
    } catch (err) {
      console.error('Failed to bootstrap settings', err)
      runInAction(() => {
        this.isBootstrapped = true
      })
      if (this.terminalTabs.length === 0) {
        this.createLocalTab()
      }
      void this.loadTools()
      void this.loadSkills()
      void this.loadCommandPolicyLists()
      void this.loadVersionState()
      void this.checkVersion({ showPopupOnVersionChange: true })
    }
  }

  createLocalTab(): void {
    const id = `local-${uuidv4()}`
    const title = this.getUniqueTitle('Local')
    const cfg: TerminalConfig = { type: 'local', id, title, cols: 80, rows: 24 }
    const tab: TerminalTabModel = { id, title, config: cfg, connectionRef: { type: 'local' } }
    this.terminalTabs.push(tab)
    this.activeTerminalId = id
  }

  createSshTab(entryId: string): void {
    const entry = this.settings?.connections?.ssh?.find((x) => x.id === entryId)
    if (!entry) {
      console.warn('SSH entry not found', entryId)
      return
    }
    const proxy = entry.proxyId
      ? this.settings?.connections?.proxies?.find((p) => p.id === entry.proxyId)
      : undefined
    const tunnels = (entry.tunnelIds ?? [])
      .map((id) => this.settings?.connections?.tunnels?.find((t) => t.id === id))
      .filter(Boolean) as any[]
    const id = `ssh-${uuidv4()}`
    const baseTitle = entry.name || `${entry.username}@${entry.host}`
    const title = this.getUniqueTitle(baseTitle)
    const jumpHost = (entry as any).jumpHost ? (toJS((entry as any).jumpHost) as any) : undefined
    const cfg: TerminalConfig = {
      type: 'ssh',
      id,
      title,
      cols: 80,
      rows: 24,
      host: entry.host,
      port: entry.port,
      username: entry.username,
      authMethod: entry.authMethod,
      password: entry.password,
      privateKey: entry.privateKey,
      privateKeyPath: entry.privateKeyPath,
      passphrase: entry.passphrase,
      proxy,
      tunnels,
      jumpHost
    } as any
    const tab: TerminalTabModel = { id, title, config: cfg, connectionRef: { type: 'ssh', entryId } }
    this.terminalTabs.push(tab)
    this.activeTerminalId = id
  }

  async saveSshConnection(entry: AppSettings['connections']['ssh'][number]): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings())
    const plainEntry = toJS(entry)
    const list = current.connections.ssh.slice().map((x) => toJS(x))
    const nextList = upsertById(list, plainEntry)

    const nextConnections = { ...toJS(current.connections), ssh: nextList }

    runInAction(() => {
      if (this.settings) {
        this.settings.connections.ssh = nextList as any
      }
    })

    await window.gyshell.settings.set({ connections: nextConnections })
  }

  async deleteSshConnection(id: string): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings())
    const list = removeById(current.connections.ssh, id).map((x) => toJS(x))
    const nextConnections = { ...toJS(current.connections), ssh: list }
    runInAction(() => {
      if (this.settings) {
        this.settings.connections.ssh = list as any
      }
    })
    await window.gyshell.settings.set({ connections: nextConnections })
  }

  async saveModel(model: ModelDefinition): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings())
    const items = current.models.items.slice().map((x) => toJS(x))
    const modelSnapshot = toJS(model)
    const plainModel: ModelDefinition = {
      ...modelSnapshot,
      supportsStructuredOutput: modelSnapshot.supportsStructuredOutput === true,
      // Ensure profile is a plain object for IPC cloning
      profile: modelSnapshot.profile ? toJS(modelSnapshot.profile) : undefined
    }
    let nextProfile: ModelDefinition['profile'] = {
      imageInputs: false,
      textOutputs: false,
      testedAt: Date.now(),
      ok: false,
      error: 'Probe failed'
    }
    try {
      const probeResult = await window.gyshell.models.probe(plainModel)
      nextProfile = {
        imageInputs: probeResult.imageInputs,
        textOutputs: probeResult.textOutputs,
        testedAt: probeResult.testedAt,
        ok: probeResult.ok,
        error: probeResult.error
      }
    } catch (err) {
      nextProfile = {
        imageInputs: false,
        textOutputs: false,
        testedAt: Date.now(),
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }
    const nextModel: ModelDefinition = {
      ...plainModel,
      profile: nextProfile
    }
    const nextItems = upsertById(items, nextModel)

    const nextModels = { ...toJS(current.models), items: nextItems }

    runInAction(() => {
      if (this.settings) {
        this.settings.models = nextModels as any
      }
    })
    await window.gyshell.settings.set({ models: nextModels })
  }

  async deleteModel(id: string): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings())
    const items = removeById(current.models.items, id).map((x) => toJS(x))
    const nextModels = { ...toJS(current.models), items }

    runInAction(() => {
      if (this.settings) {
        this.settings.models = nextModels as any
      }
    })
    await window.gyshell.settings.set({ models: nextModels })
  }

  async saveProfile(profile: AppSettings['models']['profiles'][number]): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings())
    const profiles = current.models.profiles.slice().map((x) => toJS(x))
    const plainProfile = toJS(profile)
    const nextProfiles = upsertById(profiles, plainProfile)

    const nextModels = { ...toJS(current.models), profiles: nextProfiles }

    runInAction(() => {
      if (this.settings) {
        this.settings.models = nextModels as any
      }
    })
    await window.gyshell.settings.set({ models: nextModels })
  }

  async deleteProfile(id: string): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings())
    const profiles = removeById(current.models.profiles, id).map((x) => toJS(x))
    // If active profile is deleted, reset to first available or default
    let activeProfileId = current.models.activeProfileId
    if (activeProfileId === id) {
        activeProfileId = profiles[0]?.id || ''
    }

    const nextModels = { ...toJS(current.models), profiles, activeProfileId }

    runInAction(() => {
      if (this.settings) {
        this.settings.models = nextModels as any
      }
    })
    await window.gyshell.settings.set({ models: nextModels })
  }

  async setActiveProfile(id: string): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings())
    const nextModels = { ...toJS(current.models), activeProfileId: id }

    runInAction(() => {
      if (this.settings) {
        this.settings.models.activeProfileId = id
      }
    })
    await window.gyshell.settings.set({ models: nextModels })
  }

  async saveProxy(entry: ProxyEntry): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings())
    const plainEntry = toJS(entry)
    const list = current.connections.proxies.slice().map((x) => toJS(x))
    const nextList = upsertById(list, plainEntry)

    const nextConnections = { ...toJS(current.connections), proxies: nextList }
    runInAction(() => {
      if (this.settings) {
        this.settings.connections.proxies = nextList as any
      }
    })
    await window.gyshell.settings.set({ connections: nextConnections })
  }

  async deleteProxy(id: string): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings())
    const list = removeById(current.connections.proxies, id).map((x) => toJS(x))
    const nextConnections = { ...toJS(current.connections), proxies: list }
    runInAction(() => {
      if (this.settings) {
        this.settings.connections.proxies = list as any
      }
    })
    await window.gyshell.settings.set({ connections: nextConnections })
  }

  async saveTunnel(entry: TunnelEntry): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings())
    const plainEntry = toJS(entry)
    const list = current.connections.tunnels.slice().map((x) => toJS(x))
    const nextList = upsertById(list, plainEntry)

    const nextConnections = { ...toJS(current.connections), tunnels: nextList }
    runInAction(() => {
      if (this.settings) {
        this.settings.connections.tunnels = nextList as any
      }
    })
    await window.gyshell.settings.set({ connections: nextConnections })
  }

  async deleteTunnel(id: string): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings())
    const list = removeById(current.connections.tunnels, id).map((x) => toJS(x))
    const nextConnections = { ...toJS(current.connections), tunnels: list }
    runInAction(() => {
      if (this.settings) {
        this.settings.connections.tunnels = list as any
      }
    })
    await window.gyshell.settings.set({ connections: nextConnections })
  }

  async closeTab(tabId: string): Promise<void> {
    const idx = this.terminalTabs.findIndex((t) => t.id === tabId)
    if (idx < 0) return

    const wasActive = this.activeTerminalId === tabId
    const nextTabs = this.terminalTabs.slice()
    nextTabs.splice(idx, 1)

    let nextActive: string | null = this.activeTerminalId
    if (wasActive) {
      nextActive = nextTabs[idx]?.id ?? nextTabs[idx - 1]?.id ?? null
    }

    runInAction(() => {
      this.terminalTabs = nextTabs
      this.activeTerminalId = nextActive
    })

    // Kill backend session (best-effort)
    try {
      await window.gyshell.terminal.kill(tabId)
    } catch {
      // ignore
    }

    // Never leave the app without a terminal
    if (this.terminalTabs.length === 0) {
      this.createLocalTab()
    }
  }

  sendChatMessage(
    sessionId: string,
    content: string,
    options?: { mode?: 'normal' | 'queue' }
  ): boolean {
    const mode = options?.mode || 'normal'
    let targetSessionId = sessionId
    if (!targetSessionId) {
      targetSessionId = this.chat.createSession()
    }
    
    const session = this.chat.sessions.find(s => s.id === targetSessionId)
    const wasBusy = !!session?.isSessionBusy
    if (mode === 'queue' && session?.isSessionBusy) {
      console.warn('[AppStore] Session is busy, ignoring message:', content)
      return false
    }

    this.chat.setThinking(true, targetSessionId)
    this.chat.setSessionBusy(true, targetSessionId)
    if (!wasBusy) {
      const activeProfileId = this.settings?.models.activeProfileId || ''
      this.chat.setSessionLockedProfile(targetSessionId, activeProfileId || null)
    }

    const startMode = wasBusy && mode === 'normal' ? 'inserted' : 'normal'
    window.gyshell.agent.startTask(targetSessionId, content, { startMode })
    return true
  }

  setActiveTerminal(id: string): void {
    this.activeTerminalId = id
  }

  setTerminalSelection(terminalId: string, selectionText: string): void {
    this.terminalSelections = { ...this.terminalSelections, [terminalId]: selectionText }
  }

  getTerminalSelection(terminalId: string): string {
    return this.terminalSelections[terminalId] || ''
  }

  private ensureThemeExists(): void {
    if (!this.settings) return
    const themeId = this.settings.themeId
    const theme = resolveTheme(themeId, this.customThemes)
    if (theme.id !== themeId) {
      void this.setThemeId(theme.id)
    } else {
      applyAppThemeFromTerminalScheme(theme.terminal)
      runInAction(() => {
        this.xtermTheme = toXtermTheme(theme.terminal, { transparentBackground: true })
      })
    }
  }
}
