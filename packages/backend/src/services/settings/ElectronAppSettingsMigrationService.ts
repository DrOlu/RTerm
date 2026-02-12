import Store from 'electron-store'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { BackendSettings, UiSettings } from '../../types'
import {
  DEFAULT_BACKEND_SETTINGS,
  DEFAULT_UI_SETTINGS,
  migrateBackendSettings,
  migrateUiSettings
} from './migrations'
import {
  BACKEND_SETTINGS_STORE_NAME,
  LEGACY_SETTINGS_STORE_NAME,
  UI_SETTINGS_STORE_NAME
} from './storeNames'

/**
 * Runs Electron app settings migrations at startup.
 * This module is Electron-only and owns legacy-to-current store upgrades.
 */
export class ElectronAppSettingsMigrationService {
  private getStoreFilePath(name: string): string {
    const overrideDir = (process.env.GYSHELL_STORE_DIR || '').trim()
    const baseDir = overrideDir || app.getPath('userData')
    return path.join(baseDir, `${name}.json`)
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
      console.warn('[ElectronAppSettingsMigrationService] Failed to parse legacy settings file:', error)
      return undefined
    }
  }

  private backupAndCleanupLegacy(legacyStorePath: string): void {
    if (!fs.existsSync(legacyStorePath)) return
    try {
      const backupPath = this.getBackupPath(path.dirname(legacyStorePath))
      fs.copyFileSync(legacyStorePath, backupPath)
      fs.unlinkSync(legacyStorePath)
      console.log(`[ElectronAppSettingsMigrationService] Legacy settings backed up to ${backupPath} and cleaned up.`)
    } catch (error) {
      console.warn('[ElectronAppSettingsMigrationService] Failed to backup/cleanup legacy settings file:', error)
    }
  }

  run(): void {
    // Detect whether target stores already existed before Store() applies defaults.
    // If a target file does not exist yet, we should migrate from legacy only.
    const backendStorePath = this.getStoreFilePath(BACKEND_SETTINGS_STORE_NAME)
    const uiStorePath = this.getStoreFilePath(UI_SETTINGS_STORE_NAME)
    const legacyStorePath = this.getStoreFilePath(LEGACY_SETTINGS_STORE_NAME)
    const hasBackendStore = fs.existsSync(backendStorePath)
    const hasUiStore = fs.existsSync(uiStorePath)
    const hadLegacyStore = fs.existsSync(legacyStorePath)
    const legacyRaw = this.readLegacyRaw(legacyStorePath)

    const backendStore = new Store<BackendSettings>({
      defaults: DEFAULT_BACKEND_SETTINGS,
      name: BACKEND_SETTINGS_STORE_NAME
    })

    const uiStore = new Store<UiSettings>({
      defaults: DEFAULT_UI_SETTINGS,
      name: UI_SETTINGS_STORE_NAME
    })

    const backendRaw = hasBackendStore ? (backendStore.store as unknown) : undefined
    const uiRaw = hasUiStore ? (uiStore.store as unknown) : undefined
    backendStore.store = migrateBackendSettings(backendRaw, legacyRaw) as any
    uiStore.store = migrateUiSettings(uiRaw, legacyRaw) as any

    if (hadLegacyStore) {
      this.backupAndCleanupLegacy(legacyStorePath)
    }
  }
}
