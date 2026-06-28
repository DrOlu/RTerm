import type {
  AgentSettingProfile,
  AgentSettingSnapshot,
  AgentSettingState,
  BackendSettings,
} from '../types'
import type {
  ISettingsRuntime,
  ICommandPolicyRuntime,
  IMcpRuntime,
  ISkillRuntime,
  IMemoryRuntime,
} from './runtimeContracts'
import type { CommandPolicyLists } from './CommandPolicy/CommandPolicyService'
import type { McpServerSummary } from './McpToolService'
import type { SkillInfo } from './SkillService'
import type { MemorySnapshot } from '../memory/FileMemoryStore'
import {
  getAgentSettingProfileId,
  getFirstAvailableAgentSettingSlotNumber,
  normalizeAgentSettingState,
  normalizeBooleanMap,
  normalizeCommandPolicyMode,
  normalizeAgentSettingCommandPolicyLists,
  normalizeAgentSettingProfileId,
  sortAgentSettingProfiles,
} from './settings/agentSettings'
import {
  buildBuiltInToolStatusSummary,
  buildSkillStatusSummary,
} from './Gateway/toolingSummary'

export interface AgentSettingOperationResult {
  settings: BackendSettings
  agentSettings: AgentSettingState
  commandPolicyLists: CommandPolicyLists
  mcpTools: McpServerSummary[]
  builtInTools: ReturnType<typeof buildBuiltInToolStatusSummary>
  skills: ReturnType<typeof buildSkillStatusSummary>
  memory: MemorySnapshot
  warnings: string[]
}

interface AgentSettingProfileServiceOptions {
  settingsService: ISettingsRuntime
  commandPolicyService: ICommandPolicyRuntime
  mcpToolService: IMcpRuntime
  skillService: ISkillRuntime
  memoryService: IMemoryRuntime
  onSettingsChanged?: (settings: BackendSettings) => void | Promise<void>
}

export class AgentSettingProfileService {
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: AgentSettingProfileServiceOptions) {}

  getState(): AgentSettingState {
    return this.getNormalizedAgentSettings(
      this.options.settingsService.getSettings(),
    )
  }

  async saveCurrent(): Promise<AgentSettingOperationResult> {
    return this.runMutation(async () => {
      const settings = this.options.settingsService.getSettings()
      const state = this.getNormalizedAgentSettings(settings)
      const slotNumber = getFirstAvailableAgentSettingSlotNumber(state.profiles)
      if (!slotNumber) {
        throw new Error('All Agent Setting slots are already saved.')
      }

      const now = Date.now()
      const profileId = getAgentSettingProfileId(slotNumber)
      const snapshot = await this.createCurrentSnapshot(settings)
      await this.copyActiveMemoryToProfile(settings, profileId)

      const profile: AgentSettingProfile = {
        id: profileId,
        slotNumber,
        createdAt: now,
        updatedAt: now,
        snapshot,
      }
      const nextState: AgentSettingState = {
        profiles: sortAgentSettingProfiles([...state.profiles, profile]),
        activeProfileId: profileId,
      }
      await this.persistAgentSettings(
        { ...settings, agentSettings: nextState },
        nextState,
      )
      return await this.buildResult([])
    })
  }

  async overwrite(profileId: string): Promise<AgentSettingOperationResult> {
    return this.runMutation(async () => {
      const normalizedProfileId = this.requireProfileId(profileId)
      const settings = this.options.settingsService.getSettings()
      const state = this.getNormalizedAgentSettings(settings)
      const existing = state.profiles.find(
        (profile) => profile.id === normalizedProfileId,
      )
      if (!existing) {
        throw new Error(
          `Agent Setting profile not found: ${normalizedProfileId}`,
        )
      }

      const snapshot = await this.createCurrentSnapshot(settings)
      await this.copyActiveMemoryToProfile(settings, normalizedProfileId)
      const now = Date.now()
      const nextProfiles = state.profiles.map((profile) =>
        profile.id === normalizedProfileId
          ? {
              ...profile,
              updatedAt: now,
              snapshot,
            }
          : profile,
      )
      const nextState: AgentSettingState = {
        profiles: sortAgentSettingProfiles(nextProfiles),
        activeProfileId: normalizedProfileId,
      }
      await this.persistAgentSettings(
        { ...settings, agentSettings: nextState },
        nextState,
      )
      return await this.buildResult([])
    })
  }

  async delete(profileId: string): Promise<AgentSettingOperationResult> {
    return this.runMutation(async () => {
      const normalizedProfileId = this.requireProfileId(profileId)
      const settings = this.options.settingsService.getSettings()
      const state = this.getNormalizedAgentSettings(settings)
      const nextProfiles = state.profiles.filter(
        (profile) => profile.id !== normalizedProfileId,
      )
      if (nextProfiles.length === state.profiles.length) {
        throw new Error(
          `Agent Setting profile not found: ${normalizedProfileId}`,
        )
      }
      const nextState: AgentSettingState = {
        profiles: nextProfiles,
        activeProfileId:
          state.activeProfileId === normalizedProfileId
            ? null
            : state.activeProfileId,
      }
      await this.persistAgentSettings(
        { ...settings, agentSettings: nextState },
        nextState,
      )
      return await this.buildResult([])
    })
  }

  async apply(profileId: string): Promise<AgentSettingOperationResult> {
    return this.runMutation(async () => {
      const normalizedProfileId = this.requireProfileId(profileId)
      const settings = this.options.settingsService.getSettings()
      const state = this.getNormalizedAgentSettings(settings)
      const profile = state.profiles.find(
        (entry) => entry.id === normalizedProfileId,
      )
      if (!profile) {
        throw new Error(
          `Agent Setting profile not found: ${normalizedProfileId}`,
        )
      }

      const warnings: string[] = []
      const snapshot = profile.snapshot
      const mcpTools = await this.applyMcpSnapshot(snapshot.tools.mcp)
      await this.applyCommandPolicySnapshot(
        snapshot.security.commandPolicyLists,
      )

      const currentSettings = this.options.settingsService.getSettings()
      const currentSkills = await this.options.skillService.getAll()
      const nextSettings = this.createAppliedSettings(
        currentSettings,
        snapshot,
        normalizedProfileId,
        currentSkills,
        warnings,
      )
      const nextState: AgentSettingState = {
        profiles: state.profiles,
        activeProfileId: normalizedProfileId,
      }
      await this.persistAgentSettings(
        { ...nextSettings, agentSettings: nextState },
        nextState,
      )

      return await this.buildResult(warnings, mcpTools)
    })
  }

  private async runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutationQueue.then(operation, operation)
    this.mutationQueue = pending.catch(() => undefined)
    return await pending
  }

  private requireProfileId(profileId: string): string {
    const normalizedProfileId = normalizeAgentSettingProfileId(profileId)
    if (!normalizedProfileId) {
      throw new Error(`Invalid Agent Setting profile id: ${profileId}`)
    }
    return normalizedProfileId
  }

  private getNormalizedAgentSettings(
    settings: BackendSettings,
  ): AgentSettingState {
    return normalizeAgentSettingState(settings.agentSettings, {
      recursionLimit: settings.recursionLimit ?? 200,
      experimental: settings.experimental!,
    })
  }

  private getActiveMemoryProfileId(settings: BackendSettings): string | null {
    return settings.agentSettings?.activeProfileId || null
  }

  private async copyActiveMemoryToProfile(
    settings: BackendSettings,
    profileId: string,
  ): Promise<void> {
    if (this.options.memoryService.copyMemory) {
      await this.options.memoryService.copyMemory(
        this.getActiveMemoryProfileId(settings),
        profileId,
      )
      return
    }
    const content = await this.options.memoryService.readMemory(
      this.getActiveMemoryProfileId(settings),
    )
    await this.options.memoryService.writeMemory(content, profileId)
  }

  private async createCurrentSnapshot(
    settings: BackendSettings,
  ): Promise<AgentSettingSnapshot> {
    const commandPolicyLists =
      await this.options.commandPolicyService.getLists()
    const mcpTools = this.options.mcpToolService.getSummaries()
    const skills = await this.options.skillService.getAll()
    const activeProfile = settings.models.profiles.find(
      (profile) => profile.id === settings.models.activeProfileId,
    )

    return {
      version: 1,
      security: {
        commandPolicyMode: normalizeCommandPolicyMode(
          settings.commandPolicyMode,
        ),
        commandPolicyLists:
          normalizeAgentSettingCommandPolicyLists(commandPolicyLists),
      },
      tools: {
        builtIn: normalizeBooleanMap(settings.tools?.builtIn),
        mcp: Object.fromEntries(
          mcpTools.map((tool) => [tool.name, tool.enabled !== false]),
        ),
      },
      skills: Object.fromEntries(
        skills.map((skill) => [
          skill.name,
          settings.tools?.skills?.[skill.name] !== false,
        ]),
      ),
      memory: {
        enabled: settings.memory?.enabled !== false,
      },
      workflow: {
        recursionLimit: settings.recursionLimit ?? 200,
        experimental: {
          runtimeThinkingCorrectionEnabled:
            settings.experimental?.runtimeThinkingCorrectionEnabled !== false,
          taskFinishGuardEnabled:
            settings.experimental?.taskFinishGuardEnabled !== false,
          firstTurnThinkingModelEnabled:
            settings.experimental?.firstTurnThinkingModelEnabled === true,
          execCommandActionModelEnabled:
            settings.experimental?.execCommandActionModelEnabled !== false,
          writeStdinActionModelEnabled:
            settings.experimental?.writeStdinActionModelEnabled !== false,
        },
      },
      model: {
        activeProfileId: settings.models.activeProfileId || '',
        activeProfileName: activeProfile?.name,
      },
    }
  }

  private async applyCommandPolicySnapshot(
    lists: CommandPolicyLists,
  ): Promise<void> {
    if (this.options.commandPolicyService.setLists) {
      await this.options.commandPolicyService.setLists(lists)
      return
    }

    const currentLists = await this.options.commandPolicyService.getLists()
    for (const listName of ['allowlist', 'denylist', 'asklist'] as const) {
      for (const rule of currentLists[listName]) {
        await this.options.commandPolicyService.deleteRule(listName, rule)
      }
      for (const rule of lists[listName]) {
        await this.options.commandPolicyService.addRule(listName, rule)
      }
    }
  }

  private async applyMcpSnapshot(
    enabledByName: Record<string, boolean>,
  ): Promise<McpServerSummary[]> {
    const current = this.options.mcpToolService.getSummaries()
    const currentNames = new Set(current.map((tool) => tool.name))
    const filtered = Object.fromEntries(
      Object.entries(enabledByName).filter(
        ([name, enabled]) =>
          currentNames.has(name) && typeof enabled === 'boolean',
      ),
    )

    if (this.options.mcpToolService.setServerEnabledBatch) {
      return await this.options.mcpToolService.setServerEnabledBatch(filtered)
    }

    let next = current
    for (const [name, enabled] of Object.entries(filtered)) {
      next = await this.options.mcpToolService.setServerEnabled(name, enabled)
    }
    return next
  }

  private createAppliedSettings(
    currentSettings: BackendSettings,
    snapshot: AgentSettingSnapshot,
    profileId: string,
    currentSkills: SkillInfo[],
    warnings: string[],
  ): BackendSettings {
    const currentBuiltIn = currentSettings.tools?.builtIn ?? {}
    const nextBuiltIn = { ...currentBuiltIn }
    Object.entries(snapshot.tools.builtIn).forEach(([name, enabled]) => {
      if (Object.prototype.hasOwnProperty.call(currentBuiltIn, name)) {
        nextBuiltIn[name] = enabled
      }
    })

    const currentSkillNames = new Set(currentSkills.map((skill) => skill.name))
    const nextSkills = { ...(currentSettings.tools?.skills ?? {}) }
    Object.entries(snapshot.skills).forEach(([name, enabled]) => {
      if (currentSkillNames.has(name)) {
        nextSkills[name] = enabled
      }
    })

    const modelProfileExists = currentSettings.models.profiles.some(
      (entry) => entry.id === snapshot.model.activeProfileId,
    )
    if (!modelProfileExists && snapshot.model.activeProfileId) {
      warnings.push(
        `Saved model profile "${snapshot.model.activeProfileName || snapshot.model.activeProfileId}" no longer exists. Current model profile was preserved.`,
      )
    }

    return {
      ...currentSettings,
      commandPolicyMode: snapshot.security.commandPolicyMode,
      tools: {
        builtIn: nextBuiltIn,
        skills: nextSkills,
      },
      memory: {
        enabled: snapshot.memory.enabled,
      },
      recursionLimit: snapshot.workflow.recursionLimit,
      experimental: snapshot.workflow.experimental,
      models: {
        ...currentSettings.models,
        activeProfileId: modelProfileExists
          ? snapshot.model.activeProfileId
          : currentSettings.models.activeProfileId,
      },
      agentSettings: {
        profiles: this.getNormalizedAgentSettings(currentSettings).profiles,
        activeProfileId: profileId,
      },
    }
  }

  private async persistAgentSettings(
    nextSettings: BackendSettings,
    nextState: AgentSettingState,
  ): Promise<void> {
    this.options.settingsService.setSettings({
      commandPolicyMode: nextSettings.commandPolicyMode,
      tools: nextSettings.tools,
      memory: nextSettings.memory,
      recursionLimit: nextSettings.recursionLimit,
      experimental: nextSettings.experimental,
      models: nextSettings.models,
      agentSettings: nextState,
    })
    const settings = this.options.settingsService.getSettings()
    await this.options.onSettingsChanged?.(settings)
  }

  private async buildResult(
    warnings: string[],
    mcpTools?: McpServerSummary[],
  ): Promise<AgentSettingOperationResult> {
    const settings = this.options.settingsService.getSettings()
    const allSkills = await this.options.skillService.getAll()
    const activeProfileId = settings.agentSettings?.activeProfileId || null
    return {
      settings,
      agentSettings: this.getNormalizedAgentSettings(settings),
      commandPolicyLists: await this.options.commandPolicyService.getLists(),
      mcpTools: mcpTools ?? this.options.mcpToolService.getSummaries(),
      builtInTools: buildBuiltInToolStatusSummary(settings.tools?.builtIn),
      skills: buildSkillStatusSummary(allSkills, settings.tools?.skills),
      memory:
        await this.options.memoryService.getMemorySnapshot(activeProfileId),
      warnings,
    }
  }
}
