import fs from 'node:fs'
import path from 'node:path'
import type { BackendSettings } from '../../types'
import { migrateBackendSettings } from '../../services/settings/migrations'
import { deepMerge } from '../../services/settings/objectMerge'

function bootstrapPatchFromEnv(): Partial<BackendSettings> {
  const modelName = (process.env.GYBACKEND_MODEL || '').trim()
  const apiKey = (process.env.GYBACKEND_API_KEY || '').trim()
  const baseUrl = (process.env.GYBACKEND_BASE_URL || '').trim()

  if (!modelName) {
    return {}
  }

  const modelId = 'default-model'
  const profileId = 'default-profile'

  return {
    model: modelName,
    apiKey,
    baseUrl,
    models: {
      items: [
        {
          id: modelId,
          name: modelName,
          model: modelName,
          apiKey,
          baseUrl,
          maxTokens: 200000
        }
      ],
      profiles: [
        {
          id: profileId,
          name: 'Default Profile',
          globalModelId: modelId
        }
      ],
      activeProfileId: profileId
    }
  }
}

export class NodeSettingsService {
  private readonly settingsPath: string
  private settings: BackendSettings

  constructor(private readonly dataDir: string) {
    this.settingsPath = path.join(this.dataDir, 'settings.json')
    this.settings = this.normalize(undefined)
    this.loadFromDisk()
  }

  getSettingsPath(): string {
    return this.settingsPath
  }

  getSettings(): BackendSettings {
    return this.settings
  }

  setSettings(settingsPatch: Partial<BackendSettings>): void {
    this.settings = this.normalize(deepMerge(this.settings, settingsPatch))
    this.persist()
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dataDir, { recursive: true })
  }

  private normalize(raw: unknown): BackendSettings {
    const mergedRaw = deepMerge(bootstrapPatchFromEnv(), (raw as Partial<BackendSettings>) ?? {})
    return migrateBackendSettings(mergedRaw)
  }

  private loadFromDisk(): void {
    this.ensureDir()

    if (!fs.existsSync(this.settingsPath)) {
      this.persist()
      return
    }

    try {
      const raw = fs.readFileSync(this.settingsPath, 'utf8')
      const parsed = JSON.parse(raw)
      this.settings = this.normalize(parsed)
      this.persist()
    } catch (error) {
      console.warn('[NodeSettingsService] Failed to parse settings.json, fallback to defaults:', error)
      this.settings = this.normalize(undefined)
      this.persist()
    }
  }

  private persist(): void {
    this.ensureDir()
    fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf8')
  }
}
