import Store from 'electron-store'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { BackendSettings } from '../../../backend/src/types'
import type { UiSettings } from './types'
import {
  DEFAULT_BACKEND_SETTINGS,
  migrateBackendSettings
} from '../../../backend/src/services/settings/migrations'
import { DEFAULT_UI_SETTINGS, migrateUiSettings } from './migrations'
import {
  BACKEND_SETTINGS_STORE_NAME,
  LEGACY_SETTINGS_STORE_NAME
} from '../../../backend/src/services/settings/storeNames'
import { UI_SETTINGS_STORE_NAME } from './storeNames'
import {
  sanitizeSettingsJsonFile,
  type SettingsSanitizeResult
} from './sanitizeSettingsJson'

/**
 * Runs Electron app settings migrations at startup.
 * This module is Electron-only and owns legacy-to-current store upgrades.
 */
export class ElectronAppSettingsMigration {
  private getBaseDir(): string {
    const overrideDir = (process.env.GYSHELL_STORE_DIR || '').trim()
    return overrideDir || app.getPath('userData')
  }

  private getStoreFilePath(name: string): string {
    return path.join(this.getBaseDir(), `${name}.json`)
  }

  private getBackupPath(baseDir: string): string {
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    let candidate = path.join(baseDir, `${LEGACY_SETTINGS_STORE_NAME}.backup-${stamp}.json`)
    let suffix = 1
    while (fs.existsSync(candidate)) {
      candidate = path.join(baseDir, `${LEGACY_SETTINGS_STORE_NAME}.backup-${stamp}-${suffix}.json`)
      suffix += 1
    }
    return candidate
  }

  private readLegacyRaw(legacyStorePath: string): unknown | undefined {
    if (!fs.existsSync(legacyStorePath)) return undefined
    try {
      const text = fs.readFileSync(legacyStorePath, 'utf8').trim()
      if (!text) return undefined
      return JSON.parse(text)
    } catch (error) {
      console.warn('[ElectronAppSettingsMigration] Failed to parse legacy settings file:', error)
      return undefined
    }
  }

  /**
   * v3.9.5: delegate to the shared, unit-tested sanitizer
   * (sanitizeSettingsJson.ts) — see that file for the full rationale.
   */
  private sanitizeSettingsFile(storePath: string): SettingsSanitizeResult {
    const result = sanitizeSettingsJsonFile(storePath)
    if (result.outcome === 'quarantined-corrupt') {
      console.warn(
        `[ElectronAppSettingsMigration] Settings file was corrupt (BOM + invalid JSON); quarantined to ${result.backupPath} and reset to defaults.`
      )
    } else if (result.outcome === 'bom-stripped') {
      console.warn(
        '[ElectronAppSettingsMigration] Settings file had a UTF-8 BOM (an external tool rewrote it); stripped so the app can read it.'
      )
    } else if (result.outcome === 'error') {
      console.warn('[ElectronAppSettingsMigration] Failed to sanitize settings file:', result.error)
    }
    return result
  }

  private backupAndCleanupLegacy(legacyStorePath: string): void {
    if (!fs.existsSync(legacyStorePath)) return
    try {
      const backupPath = this.getBackupPath(path.dirname(legacyStorePath))
      fs.copyFileSync(legacyStorePath, backupPath)
      fs.unlinkSync(legacyStorePath)
      console.log(`[ElectronAppSettingsMigration] Legacy settings backed up to ${backupPath} and cleaned up.`)
    } catch (error) {
      console.warn('[ElectronAppSettingsMigration] Failed to backup/cleanup legacy settings file:', error)
    }
  }

  run(): void {
    // Detect whether target stores already existed before Store() applies defaults.
    // If a target file does not exist yet, we should migrate from legacy only.
    const backendStorePath = this.getStoreFilePath(BACKEND_SETTINGS_STORE_NAME)
    const uiStorePath = this.getStoreFilePath(UI_SETTINGS_STORE_NAME)
    const legacyStorePath = this.getStoreFilePath(LEGACY_SETTINGS_STORE_NAME)
    // v3.9.5: a BOM'd or corrupt settings file must never kill startup —
    // sanitize all three store files BEFORE electron-store parses them,
    // and never let the migration itself take the app down.
    try {
      this.sanitizeSettingsFile(backendStorePath)
      this.sanitizeSettingsFile(uiStorePath)
      this.sanitizeSettingsFile(legacyStorePath)
    } catch (error) {
      console.warn('[ElectronAppSettingsMigration] Settings sanitize failed:', error)
    }
    const hasBackendStore = fs.existsSync(backendStorePath)
    const hasUiStore = fs.existsSync(uiStorePath)
    const hadLegacyStore = fs.existsSync(legacyStorePath)
    const legacyRaw = this.readLegacyRaw(legacyStorePath)

    let backendStore: Store<BackendSettings>
    let uiStore: Store<UiSettings>
    try {
      backendStore = new Store<BackendSettings>({
        defaults: DEFAULT_BACKEND_SETTINGS,
        name: BACKEND_SETTINGS_STORE_NAME
      })

      uiStore = new Store<UiSettings>({
        defaults: DEFAULT_UI_SETTINGS,
        name: UI_SETTINGS_STORE_NAME
      })
    } catch (error) {
      // v3.9.5: even after sanitizing, an unexpected parse failure must
      // never take the app down — quarantine both files and boot with
      // defaults. A user loses settings; losing the WHOLE APP to a JSON
      // file is the "double-click does nothing" bug.
      console.warn('[ElectronAppSettingsMigration] Settings store failed to open; quarantining and resetting:', error)
      for (const p of [backendStorePath, uiStorePath]) {
        try {
          if (fs.existsSync(p)) {
            fs.copyFileSync(p, `${p}.corrupt-${Date.now()}`)
            fs.rmSync(p, { force: true })
          }
        } catch { /* best effort */ }
      }
      backendStore = new Store<BackendSettings>({
        defaults: DEFAULT_BACKEND_SETTINGS,
        name: BACKEND_SETTINGS_STORE_NAME
      })
      uiStore = new Store<UiSettings>({
        defaults: DEFAULT_UI_SETTINGS,
        name: UI_SETTINGS_STORE_NAME
      })
    }

    const backendRaw = hasBackendStore ? (backendStore.store as unknown) : undefined
    const uiRaw = hasUiStore ? (uiStore.store as unknown) : undefined
    backendStore.store = migrateBackendSettings(backendRaw, legacyRaw) as any
    uiStore.store = migrateUiSettings(uiRaw, legacyRaw) as any

    if (hadLegacyStore) {
      this.backupAndCleanupLegacy(legacyStorePath)
    }
  }
}
