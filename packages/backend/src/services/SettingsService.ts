import Store from 'electron-store'
import type { BackendSettings } from '../types'
import { migrateBackendSettings, DEFAULT_BACKEND_SETTINGS } from './settings/migrations'
import { deepMerge } from './settings/objectMerge'
import { BACKEND_SETTINGS_STORE_NAME } from './settings/storeNames'
import { applyMonidApiKey } from './monid/applyMonidApiKey'

export class SettingsService {
  private store: Store<BackendSettings>
  private listeners = new Set<(settings: BackendSettings) => void>()

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
    const incomingKey =
      typeof (settings as { monid?: { apiKey?: string } }).monid?.apiKey === 'string'
        ? (settings as { monid: { apiKey: string } }).monid.apiKey.trim()
        : ''
    const incomingBin =
      typeof (settings as { monid?: { binaryPath?: string } }).monid?.binaryPath === 'string'
        ? (settings as { monid: { binaryPath?: string } }).monid.binaryPath?.trim()
        : ''
    const incomingLabel =
      typeof (settings as { monid?: { keyLabel?: string } }).monid?.keyLabel === 'string'
        ? (settings as { monid: { keyLabel?: string } }).monid.keyLabel?.trim()
        : ''
    if (incomingKey) {
      try {
        applyMonidApiKey({
          apiKey: incomingKey,
          binaryPath: incomingBin || current.monid?.binaryPath,
          keyLabel: incomingLabel || current.monid?.keyLabel,
        })
      } catch {
        /* key apply is best-effort; settings still persist without the secret */
      }
    }
    const merged = deepMerge(current, settings)
    const migrated = migrateBackendSettings(merged)
    this.store.store = migrated as any
    this.emitChange()
  }

  /**
   * Subscribe to settings changes. Fires after every setSettings() (covers the
   * settings:set gateway RPC, ConnectionManager, AutomationManager, and any
   * other mutation path). Returns an unsubscribe function.
   */
  onDidChange(listener: (settings: BackendSettings) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emitChange(): void {
    const snapshot = this.store.store as BackendSettings
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        /* a faulty listener must not break settings persistence */
      }
    }
  }
}
