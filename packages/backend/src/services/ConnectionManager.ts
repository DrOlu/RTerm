import type { SSHConnectionEntry } from '../types'
import type { IConnectionManagerRuntime } from './runtimeContracts'

/**
 * Persists saved-SSH-connection mutations to backend settings and notifies
 * subscribers so the agent runtime and the UI's Connections panel both refresh
 * live. Backs the `manage_ssh_connection` agent tool.
 *
 * Settings are mutated via a thin settings-service handle (`getSettings`/
 * `setSettings`) and a broadcast callback, so this class is trivially fakeable
 * in unit tests (no electron-store needed).
 */
export interface ConnectionManagerOptions {
  getSettings: () => any
  setSettings: (patch: any) => void
  /** Called after a mutation so the agent runtime refreshes its settings snapshot. */
  onSettingsChanged?: (settings: any) => void
  /** Broadcasts the new settings to the UI (e.g. gatewayService.broadcastRaw). */
  broadcastSettings?: (settings: any) => void
}

export class ConnectionManager implements IConnectionManagerRuntime {
  private readonly opts: ConnectionManagerOptions

  constructor(opts: ConnectionManagerOptions) {
    this.opts = opts
  }

  private currentList(): SSHConnectionEntry[] {
    const settings = this.opts.getSettings()
    return Array.isArray(settings?.connections?.ssh)
      ? (settings.connections.ssh as SSHConnectionEntry[])
      : []
  }

  private commit(nextList: SSHConnectionEntry[]): SSHConnectionEntry[] {
    this.opts.setSettings({ connections: { ssh: nextList } })
    const next = this.opts.getSettings()
    // Refresh the agent runtime first (so subsequent tool calls in the same
    // flow see the new list), then push to the UI.
    this.opts.onSettingsChanged?.(next)
    this.opts.broadcastSettings?.(next)
    return nextList
  }

  listSsh(): readonly SSHConnectionEntry[] {
    return this.currentList()
  }

  createSsh(entry: SSHConnectionEntry): SSHConnectionEntry {
    const stored = { ...entry }
    if (!stored.id) stored.id = `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const next = [...this.currentList(), stored]
    this.commit(next)
    return stored
  }

  updateSsh(entry: SSHConnectionEntry): SSHConnectionEntry {
    const list = this.currentList()
    const idx = list.findIndex((e) => e.id === entry.id)
    if (idx === -1) {
      throw new Error(`No saved SSH connection with id "${entry.id}" to update.`)
    }
    const next = list.slice()
    next[idx] = { ...list[idx], ...entry, id: entry.id }
    this.commit(next)
    return next[idx]
  }

  deleteSsh(id: string): boolean {
    const list = this.currentList()
    const next = list.filter((e) => e.id !== id)
    if (next.length === list.length) return false
    this.commit(next)
    return true
  }
}
