/**
 * settingsBackup — automatic versioned backups of settings.json (v3.2.18).
 *
 * settings.json holds every connection, playbook, schedule, and model profile.
 * A bad edit or disk issue previously lost all of it. This module keeps the
 * last N timestamped backups on every save and provides restore + export.
 *
 * Pure + injectable: the file operations are injected, so the rotation logic
 * is testable without touching the real settings.
 */

export interface SettingsFileIO {
  read: () => string
  write: (content: string) => void
  /** list backup filenames (basename only) in the backup dir */
  listBackups: () => string[]
  readBackup: (name: string) => string
  writeBackup: (name: string, content: string) => void
  deleteBackup: (name: string) => void
}

export interface SettingsBackupOptions {
  /** how many backups to keep (default 20) */
  keep?: number
  /** clock, injectable */
  now?: () => Date
}

export interface BackupRecord {
  name: string
  /** parsed timestamp */
  at: Date
  /** bytes */
  size: number
}

const BACKUP_PREFIX = 'settings-backup-'
const BACKUP_SUFFIX = '.json'

/** Format a backup filename from a date. */
export function backupNameFor(date: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${BACKUP_PREFIX}${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${BACKUP_SUFFIX}`
}

/** Parse a backup filename back to a Date (null when unparseable). */
export function parseBackupName(name: string): Date | null {
  if (!name.startsWith(BACKUP_PREFIX) || !name.endsWith(BACKUP_SUFFIX)) return null
  const stem = name.slice(BACKUP_PREFIX.length, -BACKUP_SUFFIX.length)
  const m = stem.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[]
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  return Number.isNaN(date.getTime()) ? null : date
}

export class SettingsBackupService {
  private readonly keep: number
  private readonly now: () => Date

  constructor(
    private readonly io: SettingsFileIO,
    opts: SettingsBackupOptions = {},
  ) {
    this.keep = opts.keep ?? 20
    this.now = opts.now ?? (() => new Date())
  }

  /** Take a backup of the CURRENT settings content, then rotate. */
  backup(): BackupRecord {
    const content = this.io.read()
    const name = backupNameFor(this.now())
    this.io.writeBackup(name, content)
    this.rotate()
    return { name, at: this.now(), size: content.length }
  }

  /** Delete oldest backups beyond the keep limit. Returns names removed. */
  rotate(): string[] {
    const names = this.io.listBackups()
      .map((n) => ({ n, at: parseBackupName(n) }))
      .filter((x): x is { n: string; at: Date } => x.at !== null)
      .sort((a, b) => a.at.getTime() - b.at.getTime())
    const excess = names.slice(0, Math.max(0, names.length - this.keep))
    for (const { n } of excess) this.io.deleteBackup(n)
    return excess.map((x) => x.n)
  }

  /** List backups, newest first. */
  list(): BackupRecord[] {
    return this.io.listBackups()
      .map((n) => ({ n, at: parseBackupName(n) }))
      .filter((x): x is { n: string; at: Date } => x.at !== null)
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .map(({ n, at }) => ({ name: n, at, size: this.io.readBackup(n).length }))
  }

  /** Restore a backup by name (writes it to the live settings path). */
  restore(name: string): { ok: boolean; error?: string } {
    if (!this.io.listBackups().includes(name)) {
      return { ok: false, error: `no backup named "${name}"` }
    }
    // Safety: back up the CURRENT settings before overwriting them.
    this.backup()
    const content = this.io.readBackup(name)
    this.io.write(content)
    return { ok: true }
  }

  /** Export the current settings as a portable JSON string. */
  export(): string {
    return this.io.read()
  }

  /** Validate + import settings JSON. Refuses non-object / empty content. */
  import(content: string): { ok: boolean; error?: string } {
    const trimmed = (content ?? '').trim()
    if (!trimmed) return { ok: false, error: 'empty settings content' }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (e) {
      return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'settings content must be a JSON object' }
    }
    // Safety: back up before replacing.
    this.backup()
    this.io.write(trimmed)
    return { ok: true }
  }
}
