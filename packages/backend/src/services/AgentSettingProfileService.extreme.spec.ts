import type { BackendSettings } from '../types'
import { AgentSettingProfileService } from './AgentSettingProfileService'
import { migrateBackendSettings } from './settings/migrations'
import { deepMerge } from './settings/objectMerge'
import { getAgentSettingProfileId } from './settings/agentSettings'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    )
  }
}

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertDeepEqual = (
  actual: unknown,
  expected: unknown,
  message: string,
): void => {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`${message}. expected=${expectedJson} actual=${actualJson}`)
  }
}

const assertRejects = async (
  fn: () => Promise<unknown>,
  pattern: RegExp,
  message: string,
): Promise<void> => {
  try {
    await fn()
    throw new Error(`${message}: expected rejection`)
  } catch (error) {
    const actualMessage = error instanceof Error ? error.message : String(error)
    if (!pattern.test(actualMessage)) {
      throw new Error(`${message}: unexpected error "${actualMessage}"`)
    }
  }
}

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

class MockSettingsService {
  settings: BackendSettings

  constructor(initial?: Partial<BackendSettings>) {
    this.settings = migrateBackendSettings(
      deepMerge(
        {
          models: {
            items: [
              {
                id: 'model-fast',
                name: 'Fast',
                model: 'fast',
                apiKey: 'key',
                maxTokens: 200000,
                structuredOutputMode: 'auto',
                supportsStructuredOutput: false,
                supportsObjectToolChoice: false,
              },
              {
                id: 'model-deep',
                name: 'Deep',
                model: 'deep',
                apiKey: 'key',
                maxTokens: 200000,
                structuredOutputMode: 'auto',
                supportsStructuredOutput: false,
                supportsObjectToolChoice: false,
              },
            ],
            profiles: [
              { id: 'profile-fast', name: 'Fast', globalModelId: 'model-fast' },
              { id: 'profile-deep', name: 'Deep', globalModelId: 'model-deep' },
            ],
            activeProfileId: 'profile-fast',
          },
          tools: {
            builtIn: {
              exec_command: true,
              read_file: true,
              write_stdin: false,
            },
            skills: {
              docs: true,
              deploy: false,
            },
          },
          recursionLimit: 300,
          experimental: {
            runtimeThinkingCorrectionEnabled: true,
            taskFinishGuardEnabled: true,
            firstTurnThinkingModelEnabled: false,
            execCommandActionModelEnabled: true,
            writeStdinActionModelEnabled: false,
          },
        } as Partial<BackendSettings>,
        initial ?? {},
      ),
    )
  }

  getSettings(): BackendSettings {
    return this.settings
  }

  setSettings(settings: Partial<BackendSettings>): void {
    this.settings = migrateBackendSettings(deepMerge(this.settings, settings))
  }
}

class MockCommandPolicyService {
  lists = {
    allowlist: ['ls *'],
    denylist: ['rm -rf /'],
    asklist: ['git push'],
  }

  setFeedbackWaiter(): void {}
  getPolicyFilePath(): string {
    return '/tmp/command-policy.json'
  }
  async getLists() {
    return {
      allowlist: [...this.lists.allowlist],
      denylist: [...this.lists.denylist],
      asklist: [...this.lists.asklist],
    }
  }
  async addRule(listName: keyof typeof this.lists, rule: string) {
    this.lists[listName] = Array.from(new Set([...this.lists[listName], rule]))
    return this.getLists()
  }
  async deleteRule(listName: keyof typeof this.lists, rule: string) {
    this.lists[listName] = this.lists[listName].filter((item) => item !== rule)
    return this.getLists()
  }
  async setLists(lists: typeof this.lists) {
    this.lists = {
      allowlist: [...lists.allowlist],
      denylist: [...lists.denylist],
      asklist: [...lists.asklist],
    }
    return this.getLists()
  }
  async evaluate(): Promise<'allow'> {
    return 'allow'
  }
  async requestApproval(): Promise<boolean> {
    return true
  }
}

class MockMcpToolService {
  tools = [
    { name: 'search', enabled: true, status: 'connected' as const },
    { name: 'files', enabled: false, status: 'disabled' as const },
  ]

  on(): this {
    return this
  }
  getConfigPath(): string {
    return '/tmp/mcp.json'
  }
  async reloadAll() {
    return this.getSummaries()
  }
  getSummaries() {
    return this.tools.map((tool) => ({ ...tool }))
  }
  async setServerEnabled(name: string, enabled: boolean) {
    this.tools = this.tools.map((tool) =>
      tool.name === name
        ? { ...tool, enabled, status: enabled ? 'connected' : 'disabled' }
        : tool,
    )
    return this.getSummaries()
  }
  async setServerEnabledBatch(enabledByName: Record<string, boolean>) {
    for (const [name, enabled] of Object.entries(enabledByName)) {
      await this.setServerEnabled(name, enabled)
    }
    return this.getSummaries()
  }
  isMcpToolName(): boolean {
    return false
  }
  getActiveTools(): any[] {
    return []
  }
  async invokeTool(): Promise<unknown> {
    return null
  }
}

class MockSkillService {
  skills = [
    { name: 'docs', description: 'Docs' },
    { name: 'deploy', description: 'Deploy' },
  ]

  async reload() {
    return this.getAll()
  }
  async getAll() {
    return this.skills.map((skill) => ({ ...skill })) as any[]
  }
  async getEnabledSkills() {
    return this.getAll()
  }
  async readSkillContentByName(): Promise<any> {
    throw new Error('not implemented')
  }
  async createSkill(): Promise<any> {
    throw new Error('not implemented')
  }
}

class MockMemoryService {
  files = new Map<string, string>([['default', 'default memory']])

  key(profileId?: string | null): string {
    return profileId || 'default'
  }
  async ensureMemoryFile(profileId?: string | null): Promise<string> {
    const key = this.key(profileId)
    if (!this.files.has(key)) {
      this.files.set(key, '# Memory\n')
    }
    return `/tmp/${key}/memory.md`
  }
  async getMemoryFilePath(profileId?: string | null): Promise<string> {
    return this.ensureMemoryFile(profileId)
  }
  async getMemorySnapshot(profileId?: string | null) {
    const filePath = await this.ensureMemoryFile(profileId)
    return { filePath, content: this.files.get(this.key(profileId)) || '' }
  }
  async readMemory(profileId?: string | null): Promise<string> {
    await this.ensureMemoryFile(profileId)
    return this.files.get(this.key(profileId)) || ''
  }
  async writeMemory(content: string, profileId?: string | null) {
    await this.ensureMemoryFile(profileId)
    this.files.set(this.key(profileId), content)
    return this.getMemorySnapshot(profileId)
  }
  async copyMemory(
    sourceProfileId?: string | null,
    targetProfileId?: string | null,
  ) {
    return this.writeMemory(
      await this.readMemory(sourceProfileId),
      targetProfileId,
    )
  }
}

const createHarness = () => {
  const settingsService = new MockSettingsService()
  const commandPolicyService = new MockCommandPolicyService()
  const mcpToolService = new MockMcpToolService()
  const skillService = new MockSkillService()
  const memoryService = new MockMemoryService()
  let settingsChangedCount = 0
  const service = new AgentSettingProfileService({
    settingsService,
    commandPolicyService,
    mcpToolService,
    skillService,
    memoryService,
    onSettingsChanged: () => {
      settingsChangedCount += 1
    },
  })
  return {
    service,
    settingsService,
    commandPolicyService,
    mcpToolService,
    skillService,
    memoryService,
    get settingsChangedCount() {
      return settingsChangedCount
    },
  }
}

const run = async (): Promise<void> => {
  await runCase(
    'saveCurrent creates a stable slot and copies active memory',
    async () => {
      const harness = createHarness()
      await harness.service.saveCurrent()
      const state = harness.settingsService.getSettings().agentSettings!
      assertEqual(state.profiles.length, 1, 'one profile should be saved')
      assertEqual(
        state.profiles[0].id,
        getAgentSettingProfileId(1),
        'slot 1 id should be used',
      )
      assertEqual(
        state.activeProfileId,
        getAgentSettingProfileId(1),
        'new slot should become active',
      )
      assertEqual(
        await harness.memoryService.readMemory(getAgentSettingProfileId(1)),
        'default memory',
        'slot memory should be copied from default',
      )
      assertEqual(
        state.profiles[0].snapshot.model.activeProfileId,
        'profile-fast',
        'active model profile should be captured',
      )
    },
  )

  await runCase(
    'saveCurrent caps at five slots and delete reuses the freed slot',
    async () => {
      const harness = createHarness()
      await harness.service.saveCurrent()
      await harness.service.saveCurrent()
      await harness.service.saveCurrent()
      await harness.service.saveCurrent()
      await harness.service.saveCurrent()
      await assertRejects(
        () => harness.service.saveCurrent(),
        /already saved/,
        'sixth save should fail',
      )
      await harness.service.delete(getAgentSettingProfileId(4))
      await harness.service.saveCurrent()
      const slots = harness.settingsService
        .getSettings()
        .agentSettings!.profiles.map((profile) => profile.slotNumber)
        .join(',')
      assertEqual(slots, '1,2,3,4,5', 'deleted slot number should be reused')
    },
  )

  await runCase(
    'apply restores saved subsets without creating missing tools or skills',
    async () => {
      const harness = createHarness()
      await harness.service.saveCurrent()
      const slotId = getAgentSettingProfileId(1)

      harness.settingsService.setSettings({
        commandPolicyMode: 'safe',
        tools: {
          builtIn: {
            exec_command: false,
            read_file: true,
            write_stdin: true,
            newly_added_builtin: true,
          },
          skills: {
            docs: false,
            deploy: true,
            newly_added_skill: false,
          },
        },
        models: {
          ...harness.settingsService.getSettings().models,
          activeProfileId: 'profile-deep',
        },
        recursionLimit: 900,
        experimental: {
          runtimeThinkingCorrectionEnabled: false,
          taskFinishGuardEnabled: false,
          firstTurnThinkingModelEnabled: true,
          execCommandActionModelEnabled: false,
          writeStdinActionModelEnabled: true,
        },
      })
      harness.commandPolicyService.lists = {
        allowlist: ['pwd'],
        denylist: [],
        asklist: [],
      }
      await harness.mcpToolService.setServerEnabled('search', false)
      await harness.mcpToolService.setServerEnabled('files', true)
      harness.skillService.skills = [{ name: 'docs', description: 'Docs' }]
      await harness.memoryService.writeMemory('changed default', null)
      await harness.memoryService.writeMemory('slot memory', slotId)

      const result = await harness.service.apply(slotId)
      const settings = harness.settingsService.getSettings()
      assertEqual(
        settings.commandPolicyMode,
        'standard',
        'saved policy mode should be restored',
      )
      assertDeepEqual(
        await harness.commandPolicyService.getLists(),
        {
          allowlist: ['ls *'],
          denylist: ['rm -rf /'],
          asklist: ['git push'],
        },
        'command policy lists should be restored',
      )
      assertEqual(
        settings.tools.builtIn.exec_command,
        true,
        'saved built-in state should apply',
      )
      assertEqual(
        settings.tools.builtIn.newly_added_builtin,
        true,
        'new built-in absent from snapshot should remain unchanged',
      )
      assertEqual(
        settings.tools.skills?.docs,
        true,
        'existing skill should apply',
      )
      assertEqual(
        settings.tools.skills?.deploy,
        true,
        'missing current skill should remain unchanged',
      )
      assertEqual(
        settings.models.activeProfileId,
        'profile-fast',
        'saved active model profile should apply',
      )
      assertEqual(settings.recursionLimit, 300, 'recursion limit should apply')
      assertEqual(
        settings.experimental?.writeStdinActionModelEnabled,
        false,
        'workflow experimental flag should apply',
      )
      assertEqual(
        result.memory.content,
        'slot memory',
        'active memory should come from the applied slot',
      )
      assertEqual(
        harness.mcpToolService
          .getSummaries()
          .find((tool) => tool.name === 'search')?.enabled,
        true,
        'saved MCP state should apply',
      )
    },
  )

  await runCase(
    'apply preserves current model when saved model profile is missing',
    async () => {
      const harness = createHarness()
      await harness.service.saveCurrent()
      harness.settingsService.setSettings({
        models: {
          items: harness.settingsService.getSettings().models.items,
          profiles: [
            {
              id: 'profile-deep',
              name: 'Deep',
              globalModelId: 'model-deep',
            },
          ],
          activeProfileId: 'profile-deep',
        },
      })
      const result = await harness.service.apply(getAgentSettingProfileId(1))
      assertEqual(
        harness.settingsService.getSettings().models.activeProfileId,
        'profile-deep',
        'current model profile should be preserved',
      )
      assertCondition(
        result.warnings.length === 1,
        'missing model should produce warning',
      )
    },
  )

  await runCase(
    'concurrent saves are serialized into unique slots',
    async () => {
      const harness = createHarness()
      await Promise.all([
        harness.service.saveCurrent(),
        harness.service.saveCurrent(),
      ])
      const slots = harness.settingsService
        .getSettings()
        .agentSettings!.profiles.map((profile) => profile.slotNumber)
        .join(',')
      assertEqual(slots, '1,2', 'concurrent saves should not collide')
      assertEqual(harness.settingsChangedCount, 2, 'both saves should persist')
    },
  )
}

run()
  .then(() => {
    console.log('All agent setting profile service extreme tests passed.')
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
