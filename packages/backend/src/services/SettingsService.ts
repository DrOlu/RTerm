import Store from 'electron-store'
import type { BackendSettings } from '../types'
import { migrateBackendSettings, DEFAULT_BACKEND_SETTINGS } from './settings/migrations'
import { deepMerge } from './settings/objectMerge'
import { BACKEND_SETTINGS_STORE_NAME } from './settings/storeNames'

export class SettingsService {
  private store: Store<BackendSettings>

  constructor() {
    this.store = new Store<BackendSettings>({
      defaults: DEFAULT_BACKEND_SETTINGS,
      name: BACKEND_SETTINGS_STORE_NAME
    })

    this.normalizeCurrent()
  }

  private normalizeCurrent(): void {
    const currentRaw = this.store.store as unknown
    const migrated = migrateBackendSettings(currentRaw)
    this.store.store = migrated as any
  }

  getSettings(): BackendSettings {
    this.normalizeCurrent()
    return this.store.store as BackendSettings
  }

  setSettings(settings: Partial<BackendSettings>): void {
    this.normalizeCurrent()
    const current = this.store.store as BackendSettings
    const merged = deepMerge(current, settings)
    const migrated = migrateBackendSettings(merged)
    this.store.store = migrated as any
  }
}
