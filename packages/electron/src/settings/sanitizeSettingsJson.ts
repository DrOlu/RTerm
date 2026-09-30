import fs from 'node:fs'

/**
 * v3.9.5: sanitize a settings JSON file before electron-store reads it.
 *
 * electron-store's JSON.parse CHOKES on a UTF-8 BOM (EF BB BF) — and the
 * throw happens inside `new Store()`, i.e. before any of the caller's own
 * logic, so an unhandled promise rejection kills the app during startup:
 * no window, no dialog, no log — the Windows portable "double-click does
 * nothing" bug, reproduced live on Server 2022. A BOM lands in these
 * files whenever any external tool rewrites them (Windows PowerShell 5.1's
 * `Set-Content -Encoding UTF8` ALWAYS writes one; some editors and sync
 * tools do too). A truncated file (crash mid-write) is equally fatal.
 *
 * Behaviour:
 * - no BOM            -> untouched (the common case; zero writes)
 * - BOM + valid JSON  -> rewritten clean (BOM stripped)
 * - BOM + invalid JSON-> quarantined to `<path>.corrupt-<ts>` and removed,
 *                        so the app boots with defaults
 * - missing file      -> no-op
 *
 * Returns what happened, for logging and tests.
 */
export type SettingsSanitizeOutcome =
  | 'missing'
  | 'clean'
  | 'bom-stripped'
  | 'quarantined-corrupt'
  | 'error'

export interface SettingsSanitizeResult {
  outcome: SettingsSanitizeOutcome
  /** path of the quarantine backup when outcome === 'quarantined-corrupt' */
  backupPath?: string
  error?: unknown
}

export function sanitizeSettingsJsonFile(storePath: string): SettingsSanitizeResult {
  try {
    if (!fs.existsSync(storePath)) return { outcome: 'missing' }
    const raw = fs.readFileSync(storePath)
    const hasBom =
      raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
    if (!hasBom) return { outcome: 'clean' }
    const text = raw.subarray(3).toString('utf8').trim()
    try {
      JSON.parse(text)
    } catch {
      // BOM AND corrupt — quarantine, boot with defaults.
      const backupPath = `${storePath}.corrupt-${Date.now()}`
      fs.copyFileSync(storePath, backupPath)
      fs.rmSync(storePath, { force: true })
      return { outcome: 'quarantined-corrupt', backupPath }
    }
    // BOM only — rewrite clean (electron-store writes without BOM).
    fs.writeFileSync(storePath, text, 'utf8')
    return { outcome: 'bom-stripped' }
  } catch (error) {
    return { outcome: 'error', error }
  }
}
