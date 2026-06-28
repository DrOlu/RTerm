import Store from 'electron-store'
import type { UiSettings } from './types'
import { migrateUiSettings, DEFAULT_UI_SETTINGS } from './migrations'
import { deepMerge } from './objectMerge'
import { UI_SETTINGS_STORE_NAME } from './storeNames'

type UiSettingsChangeListener = (settings: UiSettings) => void

export class UiSettingsStore {
  private store: Store<UiSettings>
  private listeners = new Set<UiSettingsChangeListener>()

  constructor() {
    this.store = new Store<UiSettings>({
      defaults: DEFAULT_UI_SETTINGS,
      name: UI_SETTINGS_STORE_NAME
    })

    this.normalizeCurrent()
  }

  private normalizeCurrent(): void {
    const currentRaw = this.store.store as unknown
    const migrated = migrateUiSettings(currentRaw)
    this.store.store = migrated as any
  }

  getSettings(): UiSettings {
    this.normalizeCurrent()
    return this.store.store as UiSettings
  }

  setSettings(settings: Partial<UiSettings>): void {
    this.normalizeCurrent()
    const current = this.store.store as UiSettings
    const merged = deepMerge(current, settings)
    const migrated = migrateUiSettings(merged)
    this.store.store = migrated as any
    this.emitChange(migrated)
  }

  onChange(listener: UiSettingsChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emitChange(settings: UiSettings): void {
    this.listeners.forEach((listener) => listener(settings))
  }
}
