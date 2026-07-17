import type {
  AutomationSettings,
  GroupEntry,
  DeviceMemoryEntry,
  DeviceIncident,
  ScriptEntry,
  ScheduledTaskEntry,
  ConfigTemplateEntry,
  ConfigTemplateVersion,
} from '../../types'

/**
 * Local-only automation store (Netcatty/NetStacks-parity features that don't
 * need a server): connection groups, per-device memory, saved scripts,
 * scheduled tasks, and config templates. All mutations persist via the supplied
 * settings handle (get/set + broadcast), so the UI + agent runtime refresh live.
 *
 * Mirrors the ConnectionManager contract: trivially fakeable in unit tests by
 * passing an in-memory get/set pair — no electron-store needed.
 */
export interface AutomationManagerOptions {
  getSettings: () => any
  setSettings: (patch: any) => void
  onSettingsChanged?: (settings: any) => void
  broadcastSettings?: (settings: any) => void
}

function rid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function nowIso(): string {
  return new Date().toISOString()
}

/** A timestamp strictly after the given baseline (guarantees monotonic updatedAt). */
function bumpedAfter(baseline?: string): string {
  const base = baseline ? new Date(baseline).getTime() : 0
  return new Date(Math.max(Date.now(), base + 1)).toISOString()
}

export class AutomationManager {
  private readonly opts: AutomationManagerOptions
  constructor(opts: AutomationManagerOptions) {
    this.opts = opts
  }

  private block(): AutomationSettings {
    const s = this.opts.getSettings()
    const a = s?.automation
    if (!a || typeof a !== 'object') {
      return { groups: [], deviceMemory: [], scripts: [], scheduledTasks: [], templates: [] }
    }
    return {
      groups: a.groups ?? [],
      deviceMemory: a.deviceMemory ?? [],
      scripts: a.scripts ?? [],
      scheduledTasks: a.scheduledTasks ?? [],
      templates: a.templates ?? [],
    }
  }

  private commit(next: AutomationSettings): AutomationSettings {
    // Persist only the automation slice (deepMerge preserves everything else).
    this.opts.setSettings({ automation: next })
    const updated = this.opts.getSettings()
    this.opts.onSettingsChanged?.(updated)
    this.opts.broadcastSettings?.(updated)
    return next
  }

  // --- Groups ---
  listGroups(): readonly GroupEntry[] { return this.block().groups }
  createGroup(name: string, parentId?: string | null): GroupEntry {
    const g: GroupEntry = { id: rid('grp'), name, parentId: parentId ?? null }
    this.commit({ ...this.block(), groups: [...this.block().groups, g] })
    return g
  }
  updateGroup(g: GroupEntry): GroupEntry {
    const groups = this.block().groups
    const i = groups.findIndex((x) => x.id === g.id)
    if (i === -1) throw new Error(`No group with id "${g.id}"`)
    const next = groups.slice(); next[i] = { ...groups[i], ...g, id: g.id }
    this.commit({ ...this.block(), groups: next })
    return next[i]
  }
  deleteGroup(id: string): boolean {
    const groups = this.block().groups
    const next = groups.filter((g) => g.id !== id)
    if (next.length === groups.length) return false
    // Re-parent children of the deleted group to root.
    const reparented = next.map((g) => (g.parentId === id ? { ...g, parentId: null } : g))
    this.commit({ ...this.block(), groups: reparented })
    return true
  }

  // --- Device memory ---
  listDeviceMemory(): readonly DeviceMemoryEntry[] { return this.block().deviceMemory }
  getDeviceMemory(host: string): DeviceMemoryEntry | undefined {
    return this.block().deviceMemory.find((m) => m.host === host)
  }
  upsertDeviceMemory(entry: DeviceMemoryEntry): DeviceMemoryEntry {
    const list = this.block().deviceMemory.slice()
    const i = list.findIndex((m) => m.host === entry.host)
    if (i === -1) {
      const stored = { ...entry, incidents: entry.incidents ?? [] }
      list.push(stored)
      this.commit({ ...this.block(), deviceMemory: list })
      return stored
    }
    // Preserve existing incidents unless the caller explicitly provided a
    // non-empty replacement list (empty array = "don't touch incidents").
    const incidents = entry.incidents && entry.incidents.length > 0
      ? entry.incidents
      : (list[i].incidents ?? [])
    const merged: DeviceMemoryEntry = {
      ...list[i],
      ...entry,
      host: entry.host,
      incidents,
    }
    list[i] = merged
    this.commit({ ...this.block(), deviceMemory: list })
    return merged
  }
  addIncident(host: string, incident: Omit<DeviceIncident, 'at'> & { at?: string }): DeviceIncident {
    const list = this.block().deviceMemory.slice()
    let entry = list.find((m) => m.host === host)
    const inc: DeviceIncident = { at: incident.at ?? nowIso(), summary: incident.summary, resolution: incident.resolution, ticketId: incident.ticketId }
    if (!entry) {
      entry = { host, incidents: [inc] }
      list.push(entry)
    } else {
      entry = { ...entry, incidents: [...entry.incidents, inc] }
      const i = list.findIndex((m) => m.host === host)
      list[i] = entry
    }
    this.commit({ ...this.block(), deviceMemory: list })
    return inc
  }
  deleteDeviceMemory(host: string): boolean {
    const list = this.block().deviceMemory
    const next = list.filter((m) => m.host !== host)
    if (next.length === list.length) return false
    this.commit({ ...this.block(), deviceMemory: next })
    return true
  }

  // --- Scripts ---
  listScripts(): readonly ScriptEntry[] { return this.block().scripts }
  createScript(s: Omit<ScriptEntry, 'id' | 'createdAt' | 'updatedAt'>): ScriptEntry {
    const ts = nowIso()
    const entry: ScriptEntry = { ...s, id: rid('scr'), createdAt: ts, updatedAt: ts }
    this.commit({ ...this.block(), scripts: [...this.block().scripts, entry] })
    return entry
  }
  updateScript(s: ScriptEntry): ScriptEntry {
    const scripts = this.block().scripts
    const i = scripts.findIndex((x) => x.id === s.id)
    if (i === -1) throw new Error(`No script with id "${s.id}"`)
    const next = scripts.slice()
    next[i] = { ...scripts[i], ...s, id: s.id, updatedAt: bumpedAfter(scripts[i].updatedAt ?? scripts[i].createdAt) }
    this.commit({ ...this.block(), scripts: next })
    return next[i]
  }
  deleteScript(id: string): boolean {
    const scripts = this.block().scripts
    const next = scripts.filter((s) => s.id !== id)
    if (next.length === scripts.length) return false
    this.commit({ ...this.block(), scripts: next })
    return true
  }

  // --- Scheduled tasks ---
  listScheduledTasks(): readonly ScheduledTaskEntry[] { return this.block().scheduledTasks }
  createScheduledTask(t: Omit<ScheduledTaskEntry, 'id' | 'lastRunAt'>): ScheduledTaskEntry {
    const entry: ScheduledTaskEntry = { ...t, id: rid('sch') }
    this.commit({ ...this.block(), scheduledTasks: [...this.block().scheduledTasks, entry] })
    return entry
  }
  updateScheduledTask(t: ScheduledTaskEntry): ScheduledTaskEntry {
    const list = this.block().scheduledTasks
    const i = list.findIndex((x) => x.id === t.id)
    if (i === -1) throw new Error(`No scheduled task with id "${t.id}"`)
    const next = list.slice(); next[i] = { ...list[i], ...t, id: t.id }
    this.commit({ ...this.block(), scheduledTasks: next })
    return next[i]
  }
  deleteScheduledTask(id: string): boolean {
    const list = this.block().scheduledTasks
    const next = list.filter((t) => t.id !== id)
    if (next.length === list.length) return false
    this.commit({ ...this.block(), scheduledTasks: next })
    return true
  }
  markScheduledTaskRun(id: string): void {
    const list = this.block().scheduledTasks
    const i = list.findIndex((x) => x.id === id)
    if (i === -1) return
    const next = list.slice(); next[i] = { ...list[i], lastRunAt: nowIso() }
    this.commit({ ...this.block(), scheduledTasks: next })
  }

  // --- Config templates ---
  listTemplates(): readonly ConfigTemplateEntry[] { return this.block().templates }
  createTemplate(t: Omit<ConfigTemplateEntry, 'id' | 'versions' | 'updatedAt'>): ConfigTemplateEntry {
    const entry: ConfigTemplateEntry = { ...t, id: rid('tpl'), versions: [], updatedAt: nowIso() }
    this.commit({ ...this.block(), templates: [...this.block().templates, entry] })
    return entry
  }
  updateTemplate(t: Partial<ConfigTemplateEntry> & { id: string }): ConfigTemplateEntry {
    const list = this.block().templates
    const i = list.findIndex((x) => x.id === t.id)
    if (i === -1) throw new Error(`No template with id "${t.id}"`)
    const next = list.slice()
    next[i] = { ...list[i], ...t, id: t.id, updatedAt: bumpedAfter(list[i].updatedAt ?? list[i].versions.at(-1)?.at) }
    this.commit({ ...this.block(), templates: next })
    return next[i]
  }
  deleteTemplate(id: string): boolean {
    const list = this.block().templates
    const next = list.filter((t) => t.id !== id)
    if (next.length === list.length) return false
    this.commit({ ...this.block(), templates: next })
    return true
  }
  /** Render a template with variables and persist the rendered version. */
  saveTemplateVersion(id: string, rendered: string, variables: Record<string, unknown>): ConfigTemplateVersion {
    const list = this.block().templates
    const i = list.findIndex((x) => x.id === id)
    if (i === -1) throw new Error(`No template with id "${id}"`)
    const version: ConfigTemplateVersion = { at: nowIso(), rendered, variables }
    const next = list.slice()
    next[i] = { ...list[i], versions: [...list[i].versions, version], updatedAt: nowIso() }
    this.commit({ ...this.block(), templates: next })
    return version
  }
}
