import { z } from 'zod'
import type { ToolExecutionContext } from '../types'
import { renderTemplate, diffStrings } from '../../automation/templateEngine'
import { importPuttyReg } from '../../automation/puttyImport'
import type { SSHConnectionEntry } from '../../../types'

/**
 * Automation agent tools — surface the local automation subsystems
 * (groups, device memory, scripts, scheduled tasks, templates) and the PuTTY
 * importer to the agent. All local-only (no server). These compose with the
 * existing terminal tools: the agent can render a template, then run it on a
 * fleet tab with run_fleet_command.
 */

function emit(context: ToolExecutionContext, _toolName: string, input: unknown, output: string): void {
  context.sendEvent(context.sessionId, {
    messageId: context.messageId,
    type: 'tool_call',
    toolName: _toolName,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    output,
  })
}

function noStore(): string {
  return `Automation store is not available in this runtime (no automation manager wired).`
}

// ---------------- Device memory ----------------

export const manageDeviceMemorySchema = z.object({
  action: z.enum(['get', 'upsert', 'add_incident', 'delete', 'list']),
  host: z.string().optional().describe('Host (host or host:port) for get/upsert/add_incident/delete.'),
  role: z.string().optional(),
  standingInstructions: z.string().optional(),
  incident: z.object({
    summary: z.string(),
    resolution: z.string().optional(),
    ticketId: z.string().optional(),
  }).optional(),
})

export async function manageDeviceMemory(
  args: z.infer<typeof manageDeviceMemorySchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const m = context.automationManager
  if (!m) { const msg = noStore(); emit(context, 'manage_device_memory', args, msg); return msg }
  const { action } = args
  if (action === 'list') {
    const all = m.listDeviceMemory()
    if (!all.length) { const msg = 'No device memory entries.'; emit(context, 'manage_device_memory', args, msg); return msg }
    const body = all.map((e) => `${e.host} (role=${e.role || 'unspecified'}, ${e.incidents.length} incident(s))`).join('\n')
    const msg = `Device memory (${all.length}):\n${body}`
    emit(context, 'manage_device_memory', args, msg)
    return msg
  }
  if (!args.host) { const msg = `action="${action}" requires a host.`; emit(context, 'manage_device_memory', args, msg); return msg }
  if (action === 'get') {
    const mem = m.getDeviceMemory(args.host)
    if (!mem) { const msg = `No device memory for host "${args.host}".`; emit(context, 'manage_device_memory', args, msg); return msg }
    const msg = `Device memory for ${args.host}:\nrole: ${mem.role || 'unspecified'}\nstanding instructions: ${mem.standingInstructions || '(none)'}\nincidents (${mem.incidents.length}):\n${mem.incidents.map((i) => `- [${i.at}] ${i.summary}${i.ticketId ? ` (ticket: ${i.ticketId})` : ''}${i.resolution ? ` — ${i.resolution}` : ''}`).join('\n')}`
    emit(context, 'manage_device_memory', args, msg)
    return msg
  }
  if (action === 'add_incident') {
    if (!args.incident) { const msg = 'add_incident requires an `incident` object.'; emit(context, 'manage_device_memory', args, msg); return msg }
    const inc = m.addIncident(args.host, args.incident)
    const msg = `Recorded incident for ${args.host} at ${inc.at}: ${inc.summary}.`
    emit(context, 'manage_device_memory', args, msg)
    return msg
  }
  if (action === 'upsert') {
    const mem = m.upsertDeviceMemory({
      host: args.host,
      role: args.role,
      standingInstructions: args.standingInstructions,
      incidents: [],
    })
    const msg = `Saved device memory for ${mem.host} (role=${mem.role || 'unspecified'}).`
    emit(context, 'manage_device_memory', args, msg)
    return msg
  }
  if (action === 'delete') {
    const removed = m.deleteDeviceMemory(args.host)
    const msg = removed ? `Deleted device memory for ${args.host}.` : `No device memory for ${args.host}.`
    emit(context, 'manage_device_memory', args, msg)
    return msg
  }
  const msg = `Unknown action "${action as string}".`
  emit(context, 'manage_device_memory', args, msg)
  return msg
}

// ---------------- Scripts ----------------

export const manageScriptSchema = z.object({
  action: z.enum(['create', 'update', 'delete', 'list']),
  id: z.string().optional(),
  name: z.string().optional(),
  command: z.string().optional(),
  description: z.string().optional(),
  targets: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
})

export async function manageScript(
  args: z.infer<typeof manageScriptSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const m = context.automationManager
  if (!m) { const msg = noStore(); emit(context, 'manage_script', args, msg); return msg }
  const { action } = args
  if (action === 'list') {
    const all = m.listScripts()
    if (!all.length) { const msg = 'No saved scripts.'; emit(context, 'manage_script', args, msg); return msg }
    const body = all.map((s) => `- ${s.name} (id=${s.id}): ${s.command.split('\n')[0].slice(0, 60)}${s.command.length > 60 ? '…' : ''}`).join('\n')
    const msg = `Saved scripts (${all.length}):\n${body}`
    emit(context, 'manage_script', args, msg)
    return msg
  }
  if (action === 'create') {
    if (!args.name || !args.command) { const msg = 'create requires name + command.'; emit(context, 'manage_script', args, msg); return msg }
    const s = m.createScript({ name: args.name, command: args.command, description: args.description, targets: args.targets, tags: args.tags })
    const msg = `Created script "${s.name}" (id=${s.id}). Run it on open tabs with run_fleet_command or exec_command using its command body.`
    emit(context, 'manage_script', args, msg)
    return msg
  }
  if (action === 'update') {
    if (!args.id) { const msg = 'update requires id.'; emit(context, 'manage_script', args, msg); return msg }
    const existing = m.listScripts().find((s) => s.id === args.id)
    if (!existing) { const msg = `No script with id="${args.id}".`; emit(context, 'manage_script', args, msg); return msg }
    const s = m.updateScript({ ...existing, name: args.name ?? existing.name, command: args.command ?? existing.command, description: args.description ?? existing.description, targets: args.targets ?? existing.targets, tags: args.tags ?? existing.tags })
    const msg = `Updated script "${s.name}".`
    emit(context, 'manage_script', args, msg)
    return msg
  }
  if (action === 'delete') {
    if (!args.id) { const msg = 'delete requires id.'; emit(context, 'manage_script', args, msg); return msg }
    const removed = m.deleteScript(args.id)
    const msg = removed ? `Deleted script ${args.id}.` : `No script ${args.id}.`
    emit(context, 'manage_script', args, msg)
    return msg
  }
  const msg = `Unknown action "${action as string}".`
  emit(context, 'manage_script', args, msg)
  return msg
}

// ---------------- Groups ----------------

export const manageGroupSchema = z.object({
  action: z.enum(['create', 'update', 'delete', 'list']),
  id: z.string().optional(),
  name: z.string().optional(),
  parentId: z.string().nullable().optional(),
})

export async function manageGroup(
  args: z.infer<typeof manageGroupSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const m = context.automationManager
  if (!m) { const msg = noStore(); emit(context, 'manage_group', args, msg); return msg }
  const { action } = args
  if (action === 'list') {
    const all = m.listGroups()
    if (!all.length) { const msg = 'No groups.'; emit(context, 'manage_group', args, msg); return msg }
    const msg = `Groups (${all.length}):\n${all.map((g) => `- ${g.name} (id=${g.id}${g.parentId ? `, parent=${g.parentId}` : ''})`).join('\n')}`
    emit(context, 'manage_group', args, msg)
    return msg
  }
  if (action === 'create') {
    if (!args.name) { const msg = 'create requires name.'; emit(context, 'manage_group', args, msg); return msg }
    const g = m.createGroup(args.name, args.parentId ?? null)
    const msg = `Created group "${g.name}" (id=${g.id}). Assign a connection by setting its groupId via manage_ssh_connection.update or the Connections panel.`
    emit(context, 'manage_group', args, msg)
    return msg
  }
  if (action === 'update') {
    if (!args.id) { const msg = 'update requires id.'; emit(context, 'manage_group', args, msg); return msg }
    const g = m.updateGroup({ id: args.id, name: args.name ?? '', parentId: args.parentId })
    const msg = `Updated group "${g.name}".`
    emit(context, 'manage_group', args, msg)
    return msg
  }
  if (action === 'delete') {
    if (!args.id) { const msg = 'delete requires id.'; emit(context, 'manage_group', args, msg); return msg }
    const removed = m.deleteGroup(args.id)
    const msg = removed ? `Deleted group ${args.id} (children reparented to root).` : `No group ${args.id}.`
    emit(context, 'manage_group', args, msg)
    return msg
  }
  const msg = `Unknown action "${action as string}".`
  emit(context, 'manage_group', args, msg)
  return msg
}

// ---------------- Scheduled tasks ----------------

export const manageScheduledTaskSchema = z.object({
  action: z.enum(['create', 'update', 'delete', 'list']),
  id: z.string().optional(),
  name: z.string().optional(),
  cron: z.string().optional(),
  scriptId: z.string().optional(),
  command: z.string().optional(),
  groupId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  targets: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  retryAttempts: z.number().optional(),
  retryDelaySeconds: z.number().optional(),
})

export async function manageScheduledTask(
  args: z.infer<typeof manageScheduledTaskSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const m = context.automationManager
  if (!m) { const msg = noStore(); emit(context, 'manage_scheduled_task', args, msg); return msg }
  const { action } = args
  if (action === 'list') {
    const all = m.listScheduledTasks()
    if (!all.length) { const msg = 'No scheduled tasks.'; emit(context, 'manage_scheduled_task', args, msg); return msg }
    const msg = `Scheduled tasks (${all.length}):\n${all.map((t) => `- ${t.name} (id=${t.id}, cron="${t.cron}", enabled=${t.enabled}${t.lastRunAt ? `, lastRun=${t.lastRunAt}` : ''})`).join('\n')}`
    emit(context, 'manage_scheduled_task', args, msg)
    return msg
  }
  if (action === 'create') {
    if (!args.name || !args.cron) { const msg = 'create requires name + cron.'; emit(context, 'manage_scheduled_task', args, msg); return msg }
    if (!args.scriptId && !args.command) { const msg = 'create requires scriptId or command.'; emit(context, 'manage_scheduled_task', args, msg); return msg }
    const t = m.createScheduledTask({
      name: args.name, cron: args.cron, scriptId: args.scriptId, command: args.command,
      groupId: args.groupId, tags: args.tags, targets: args.targets,
      enabled: args.enabled ?? true, retryAttempts: args.retryAttempts, retryDelaySeconds: args.retryDelaySeconds,
    })
    const msg = `Created scheduled task "${t.name}" (id=${t.id}, cron="${t.cron}"). It will be evaluated by the local scheduler.`
    emit(context, 'manage_scheduled_task', args, msg)
    return msg
  }
  if (action === 'update') {
    if (!args.id) { const msg = 'update requires id.'; emit(context, 'manage_scheduled_task', args, msg); return msg }
    const existing = m.listScheduledTasks().find((t) => t.id === args.id)
    if (!existing) { const msg = `No task ${args.id}.`; emit(context, 'manage_scheduled_task', args, msg); return msg }
    const t = m.updateScheduledTask({ ...existing, name: args.name ?? existing.name, cron: args.cron ?? existing.cron, scriptId: args.scriptId ?? existing.scriptId, command: args.command ?? existing.command, enabled: args.enabled ?? existing.enabled, groupId: args.groupId, tags: args.tags, targets: args.targets })
    const msg = `Updated task "${t.name}".`
    emit(context, 'manage_scheduled_task', args, msg)
    return msg
  }
  if (action === 'delete') {
    if (!args.id) { const msg = 'delete requires id.'; emit(context, 'manage_scheduled_task', args, msg); return msg }
    const removed = m.deleteScheduledTask(args.id)
    const msg = removed ? `Deleted task ${args.id}.` : `No task ${args.id}.`
    emit(context, 'manage_scheduled_task', args, msg)
    return msg
  }
  const msg = `Unknown action "${action as string}".`
  emit(context, 'manage_scheduled_task', args, msg)
  return msg
}

// ---------------- Templates ----------------

export const manageTemplateSchema = z.object({
  action: z.enum(['create', 'update', 'delete', 'list', 'render', 'version']),
  id: z.string().optional(),
  name: z.string().optional(),
  body: z.string().optional(),
  variables: z.array(z.object({ name: z.string(), defaultValue: z.string().optional(), description: z.string().optional() })).optional(),
  /** Variable values for render/version. */
  values: z.record(z.string(), z.unknown()).optional(),
})

export async function manageTemplate(
  args: z.infer<typeof manageTemplateSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const m = context.automationManager
  if (!m) { const msg = noStore(); emit(context, 'manage_template', args, msg); return msg }
  const { action } = args
  if (action === 'list') {
    const all = m.listTemplates()
    if (!all.length) { const msg = 'No templates.'; emit(context, 'manage_template', args, msg); return msg }
    const msg = `Templates (${all.length}):\n${all.map((t) => `- ${t.name} (id=${t.id}, ${t.versions.length} version(s))`).join('\n')}`
    emit(context, 'manage_template', args, msg)
    return msg
  }
  if (action === 'create') {
    if (!args.name || !args.body) { const msg = 'create requires name + body.'; emit(context, 'manage_template', args, msg); return msg }
    const t = m.createTemplate({ name: args.name, body: args.body, variables: args.variables ?? [] })
    const msg = `Created template "${t.name}" (id=${t.id}). Use action="render" to preview, action="version" to save a rendered version.`
    emit(context, 'manage_template', args, msg)
    return msg
  }
  if (action === 'update') {
    if (!args.id) { const msg = 'update requires id.'; emit(context, 'manage_template', args, msg); return msg }
    const t = m.updateTemplate({ id: args.id, name: args.name, body: args.body, variables: args.variables })
    const msg = `Updated template "${t.name}".`
    emit(context, 'manage_template', args, msg)
    return msg
  }
  if (action === 'delete') {
    if (!args.id) { const msg = 'delete requires id.'; emit(context, 'manage_template', args, msg); return msg }
    const removed = m.deleteTemplate(args.id)
    const msg = removed ? `Deleted template ${args.id}.` : `No template ${args.id}.`
    emit(context, 'manage_template', args, msg)
    return msg
  }
  if (action === 'render') {
    if (!args.id) { const msg = 'render requires id.'; emit(context, 'manage_template', args, msg); return msg }
    const t = m.listTemplates().find((x) => x.id === args.id)
    if (!t) { const msg = `No template ${args.id}.`; emit(context, 'manage_template', args, msg); return msg }
    // Fill declared-variable defaults into the render values.
    const defaults: Record<string, unknown> = {}
    for (const v of t.variables) if (v.defaultValue !== undefined) defaults[v.name] = v.defaultValue
    const values = { ...defaults, ...(args.values ?? {}) }
    const rendered = renderTemplate(t.body, values)
    const msg = `Rendered preview of "${t.name}":\n<rendered>\n${rendered}\n</rendered>`
    emit(context, 'manage_template', args, msg)
    return msg
  }
  if (action === 'version') {
    if (!args.id) { const msg = 'version requires id.'; emit(context, 'manage_template', args, msg); return msg }
    const t = m.listTemplates().find((x) => x.id === args.id)
    if (!t) { const msg = `No template ${args.id}.`; emit(context, 'manage_template', args, msg); return msg }
    const defaults: Record<string, unknown> = {}
    for (const v of t.variables) if (v.defaultValue !== undefined) defaults[v.name] = v.defaultValue
    const values = { ...defaults, ...(args.values ?? {}) }
    const rendered = renderTemplate(t.body, values)
    const v = m.saveTemplateVersion(t.id, rendered, values)
    const prev = t.versions.at(-1)
    const diff = prev ? `\n\nDiff vs previous version:\n${diffStrings(prev.rendered, rendered)}` : '\n\n(first version)'
    const msg = `Saved version ${t.versions.length + 1} of "${t.name}" at ${v.at}.${diff}`
    emit(context, 'manage_template', args, msg)
    return msg
  }
  const msg = `Unknown action "${action as string}".`
  emit(context, 'manage_template', args, msg)
  return msg
}

// ---------------- PuTTY import ----------------

export const importPuttySchema = z.object({
  regContent: z.string().describe('Contents of a PuTTY .reg export (Windows Registry Editor format).'),
})

export async function importPutty(
  args: z.infer<typeof importPuttySchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const cm = context.connectionManager
  if (!cm) { const msg = 'Connection management is not available in this runtime.'; emit(context, 'import_putty', args, msg); return msg }
  const entries: SSHConnectionEntry[] = importPuttyReg(args.regContent)
  if (!entries.length) { const msg = 'No SSH sessions found in the provided PuTTY export (only ssh-protocol sessions with a HostName are imported).' ; emit(context, 'import_putty', args, msg); return msg }
  let created = 0
  const existing = new Set(cm.listSsh().map((e) => e.name))
  for (const e of entries) {
    if (existing.has(e.name)) continue // skip duplicates by name
    cm.createSsh(e)
    created++
  }
  const msg = `Imported ${created} SSH connection(s) from PuTTY${entries.length !== created ? ` (${entries.length - created} skipped as duplicates or non-ssh)` : ''}. Imported: ${entries.map((e) => e.name).join(', ')}. Open them with open_terminal_tab by Name.`
  emit(context, 'import_putty', args, msg)
  return msg
}
