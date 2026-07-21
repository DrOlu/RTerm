import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'crypto'

/**
 * Plugin system — manifest, registry, and register(ctx) lifecycle.
 *
 * Anyone can develop a custom plugin and have it auto-integrate with RTerm:
 * drop a folder into `plugins/` with a `plugin.json` manifest + a small code
 * file, and RTerm discovers it, loads it, calls its `register(ctx)` with RTerm's
 * services, and the plugin's capabilities (tools, triggers, panels, commands)
 * appear automatically — no RTerm code changes needed.
 *
 * Design:
 *   - Discovery mirrors the FileSkillStore pattern (scan a root for folders).
 *   - Manifest (plugin.json) declares name, version, description, and what the
 *     plugin provides (tools, triggers, panels, permissions).
 *   - Lifecycle: discover -> load (dynamic import) -> register(ctx) -> manage
 *     (enable/disable/uninstall). Pure + injectable for full testability.
 */

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface PluginToolDecl {
  name: string
  description?: string
}

export interface PluginTriggerDecl {
  name: string
  kind: 'pattern' | 'threshold' | 'webhook' | 'schedule'
  match?: string
  metric?: string
  op?: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'
  value?: number
}

export interface PluginManifest {
  name: string
  version: string
  description?: string
  author?: string
  /** the entry module (default index.js / index.ts). */
  entry?: string
  /** declared capabilities (for discovery/permissions UI). */
  tools?: Array<string | PluginToolDecl>
  triggers?: Array<string | PluginTriggerDecl>
  panels?: string[]
  /** permissions the plugin requests (exec_command, read_ledger, network, etc.). */
  permissions?: string[]
}

// ---------------------------------------------------------------------------
// Plugin context (the services RTerm hands to a plugin at register time)
// ---------------------------------------------------------------------------

export interface PluginToolDefinition {
  name: string
  description: string
  /** the tool handler: (args) => result string or object. */
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

export interface PluginTriggerDefinition {
  name: string
  kind: PluginTriggerDecl['kind']
  match?: string
  metric?: string
  op?: PluginTriggerDecl['op']
  value?: number
  action: string
}

export interface PluginContext {
  /** register an agent tool the plugin provides (callable by the agent). */
  registerTool: (tool: PluginToolDefinition) => void
  /** register an event-driven trigger the plugin provides. */
  registerTrigger: (trigger: PluginTriggerDefinition) => void
  /** register a dashboard panel the plugin provides. */
  registerPanel: (name: string, render: () => Promise<string> | string) => void
  /** run a command on a host (the agent's exec path, policy-gated). */
  exec: (command: string, opts?: { host?: string }) => Promise<string>
  /** read a ledger's data (metrics/incidents/etc.). */
  readLedger: (name: string, query?: Record<string, unknown>) => unknown
  /** log a line to the RTerm log. */
  log: (line: string) => void
}

export type PluginRegisterFn = (ctx: PluginContext) => void | Promise<void>

export interface PluginModule {
  register: PluginRegisterFn
  /** optional teardown when the plugin is disabled/uninstalled. */
  unregister?: () => void | Promise<void>
}

// ---------------------------------------------------------------------------
// Plugin record
// ---------------------------------------------------------------------------

export interface PluginRecord {
  id: string
  dir: string
  manifest: PluginManifest
  enabled: boolean
  loadedAt?: number
  tools: PluginToolDefinition[]
  triggers: PluginTriggerDefinition[]
  panels: Array<{ name: string; render: () => Promise<string> | string }>
  error?: string
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface PluginRegistryOptions {
  /** root folder(s) to scan for plugins. */
  scanRoots: string[]
  /** build the PluginContext for a plugin (injected — wires to RTerm's services). */
  createContext: (plugin: PluginRecord) => PluginContext
  /** load the plugin's entry module (injected — defaults to dynamic import). */
  loadModule?: (entryPath: string) => Promise<PluginModule>
  now?: () => number
  onLog?: (line: string) => void
}

const DEFAULT_ENTRY_CANDIDATES = ['index.js', 'index.ts', 'index.mjs']

export class PluginRegistry {
  private readonly plugins = new Map<string, PluginRecord>()
  private readonly now: () => number

  constructor(private readonly opts: PluginRegistryOptions) {
    this.now = opts.now ?? (() => Date.now())
  }

  private log(line: string): void {
    try { this.opts.onLog?.(line) } catch { /* best-effort */ }
  }

  /** All discovered plugins. */
  list(): readonly PluginRecord[] {
    return Array.from(this.plugins.values())
  }

  get(idOrName: string): PluginRecord | undefined {
    const needle = idOrName.trim().toLowerCase()
    return this.plugins.get(idOrName) ??
      Array.from(this.plugins.values()).find((p) => p.manifest.name.trim().toLowerCase() === needle)
  }

  /** Discover + load + register every plugin found in the scan roots. */
  async reload(): Promise<PluginRecord[]> {
    for (const root of this.opts.scanRoots) {
      const exists = await fs.access(root).then(() => true).catch(() => false)
      if (!exists) continue
      let entries
      try {
        entries = await fs.readdir(root, { withFileTypes: true })
      } catch (e) {
        this.log(`[plugin] failed to read root ${root}: ${e instanceof Error ? e.message : String(e)}`)
        continue
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || !entry.isDirectory()) continue
        const dir = path.join(root, entry.name)
        await this.loadFromDir(dir)
      }
    }
    return this.list() as PluginRecord[]
  }

  /** Load + register a single plugin from a directory (must contain plugin.json). */
  async loadFromDir(dir: string): Promise<PluginRecord | undefined> {
    const manifestPath = path.join(dir, 'plugin.json')
    let manifest: PluginManifest
    try {
      const text = await fs.readFile(manifestPath, 'utf8')
      manifest = JSON.parse(text) as PluginManifest
    } catch (e) {
      this.log(`[plugin] ${dir}: no valid plugin.json (${e instanceof Error ? e.message : String(e)})`)
      return undefined
    }
    if (!manifest.name || !manifest.version) {
      this.log(`[plugin] ${dir}: plugin.json missing required name/version`)
      return undefined
    }

    // dedupe by name (a reloaded plugin replaces the previous one).
    const existing = Array.from(this.plugins.values()).find((p) => p.manifest.name === manifest.name)
    if (existing) {
      try { await this.unloadModule(existing) } catch { /* best-effort */ }
      this.plugins.delete(existing.id)
    }

    const record: PluginRecord = {
      id: `plugin-${randomUUID().slice(0, 8)}`,
      dir,
      manifest,
      enabled: true,
      tools: [],
      triggers: [],
      panels: [],
    }

    const entryName = manifest.entry ?? await this.resolveEntry(dir)
    if (!entryName) {
      record.error = `no entry module found (tried ${DEFAULT_ENTRY_CANDIDATES.join(', ')})`
      this.log(`[plugin] ${manifest.name}: ${record.error}`)
      this.plugins.set(record.id, record)
      return record
    }

    const entryPath = path.join(dir, entryName)
    try {
      const mod = this.opts.loadModule
        ? await this.opts.loadModule(entryPath)
        : await this.defaultLoadModule(entryPath)
      if (!mod || typeof mod.register !== 'function') {
        throw new Error('entry module does not export a register(ctx) function')
      }

      // Build the context (wires the plugin's registrations into the record).
      const ctx = this.opts.createContext(record)
      await mod.register(ctx)
      record.loadedAt = this.now()
      this.plugins.set(record.id, record)
      this.log(`[plugin] loaded ${manifest.name}@${manifest.version} (${record.tools.length} tools, ${record.triggers.length} triggers, ${record.panels.length} panels)`)
      return record
    } catch (e) {
      record.error = e instanceof Error ? e.message : String(e)
      this.log(`[plugin] ${manifest.name} failed to load: ${record.error}`)
      this.plugins.set(record.id, record)
      return record
    }
  }

  private async resolveEntry(dir: string): Promise<string | undefined> {
    for (const cand of DEFAULT_ENTRY_CANDIDATES) {
      const p = path.join(dir, cand)
      const ok = await fs.access(p).then(() => true).catch(() => false)
      if (ok) return cand
    }
    return undefined
  }

  private async defaultLoadModule(entryPath: string): Promise<PluginModule> {
    const url = `file://${entryPath}`
    return (await import(url)) as PluginModule
  }

  private async unloadModule(record: PluginRecord): Promise<void> {
    // Teardown is best-effort (the module's unregister may not exist).
    // The record's tools/triggers/panels are dropped with the record.
    void record
  }

  /** Enable/disable a plugin (its capabilities are gated by `enabled`). */
  setEnabled(idOrName: string, enabled: boolean): boolean {
    const p = this.get(idOrName)
    if (!p) return false
    p.enabled = enabled
    return true
  }

  /** Uninstall a plugin (drop it from the registry). */
  uninstall(idOrName: string): boolean {
    const p = this.get(idOrName)
    if (!p) return false
    return this.plugins.delete(p.id)
  }

  /** All tools from enabled plugins. */
  allTools(): PluginToolDefinition[] {
    return this.list().filter((p) => p.enabled && !p.error).flatMap((p) => p.tools)
  }

  /** All triggers from enabled plugins. */
  allTriggers(): PluginTriggerDefinition[] {
    return this.list().filter((p) => p.enabled && !p.error).flatMap((p) => p.triggers)
  }

  /** All panels from enabled plugins. */
  allPanels(): Array<{ name: string; render: () => Promise<string> | string }> {
    return this.list().filter((p) => p.enabled && !p.error).flatMap((p) => p.panels)
  }

  /** Build the default PluginContext for a record (registers into the record's
   * capability lists; exec/readLedger/log are delegated to the injected fns). */
  static defaultContext(
    record: PluginRecord,
    exec: PluginContext['exec'],
    readLedger: PluginContext['readLedger'],
    log: PluginContext['log'],
  ): PluginContext {
    return {
      registerTool: (tool) => { record.tools.push(tool) },
      registerTrigger: (trigger) => { record.triggers.push(trigger) },
      registerPanel: (name, render) => { record.panels.push({ name, render }) },
      exec,
      readLedger,
      log,
    }
  }
}
