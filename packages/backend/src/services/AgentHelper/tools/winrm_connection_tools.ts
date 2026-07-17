import { z } from 'zod'
import type { WinRMConnectionEntry } from '../../../types'
import type { ToolExecutionContext } from '../types'

/**
 * `manage_winrm_connection` — the WinRM counterpart of manage_ssh_connection.
 * The agent can provision, edit, remove, and list saved Windows Remote
 * Management connections (WS-Management 5985/5986). After creating one, it
 * opens a tab with open_terminal_tab and runs PowerShell/cmd commands via
 * exec_command / run_fleet_command (command/response mode — no PTY).
 */

const winrmConnectionFieldsSchema = z.object({
  name: z.string().min(1).describe('Display name; must be unique across saved WinRM connections.'),
  host: z.string().min(1).describe('Hostname or IP of the Windows host.'),
  port: z.number().int().min(1).max(65535).default(5985),
  username: z.string().min(1).describe('Windows admin username.'),
  password: z.string().min(1).describe('Windows password (Basic auth).'),
  transport: z
    .enum(['http', 'https'])
    .optional()
    .describe('http (5985) or https (5986). Defaults from port.'),
  auth: z
    .enum(['basic', 'negotiate'])
    .optional()
    .describe('Auth scheme. v1 implements basic (lab/non-domain).'),
  domain: z.string().optional().describe('Active Directory domain (sent as DOMAIN\\user).'),
  rejectUnauthorized: z
    .boolean()
    .optional()
    .describe('For https with self-signed certs, set false to skip cert verification.'),
  groupId: z.string().optional().describe('ID of a saved group/folder (create one with manage_group).'),
  notes: z.string().optional().describe('Free-form operator notes for this connection.'),
})

export const manageWinrmConnectionSchema = z.object({
  action: z
    .enum(['create', 'update', 'delete', 'list'])
    .describe('create / update (by id) / delete (by id) / list saved WinRM connections.'),
  id: z.string().optional().describe('ID for update/delete.'),
  connection: winrmConnectionFieldsSchema.optional(),
})

export type ManageWinrmConnectionArgs = z.infer<typeof manageWinrmConnectionSchema>

function emit(context: ToolExecutionContext, input: unknown, output: string): void {
  context.sendEvent(context.sessionId, {
    messageId: context.messageId,
    type: 'tool_call',
    toolName: 'manage_winrm_connection',
    input: typeof input === 'string' ? input : JSON.stringify(input),
    output,
  })
}

function randomId(): string {
  return `winrm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function toEntry(fields: z.infer<typeof winrmConnectionFieldsSchema>, id: string): WinRMConnectionEntry {
  return {
    id,
    name: fields.name,
    host: fields.host,
    port: fields.port,
    username: fields.username,
    password: fields.password,
    transport: fields.transport,
    auth: fields.auth,
    domain: fields.domain,
    rejectUnauthorized: fields.rejectUnauthorized,
    groupId: fields.groupId,
    notes: fields.notes,
  }
}

function summarize(entry: WinRMConnectionEntry): string {
  const proto = entry.transport ?? (entry.port === 5986 ? 'https' : 'http')
  const dom = entry.domain ? `${entry.domain}\\` : ''
  const grp = entry.groupId ? `, group=${entry.groupId}` : ''
  return `${entry.name} (id=${entry.id}, ${dom}${entry.username}@${entry.host}:${entry.port} ${proto}${grp})`
}

export async function manageWinrmConnection(
  args: ManageWinrmConnectionArgs,
  context: ToolExecutionContext,
): Promise<string> {
  const cm = context.connectionManager
  if (!cm) {
    const msg = 'Connection management is not available in this runtime (no connection manager wired).'
    emit(context, args, msg)
    return msg
  }

  const { action } = args

  if (action === 'list') {
    const entries = cm.listWinrm()
    if (entries.length === 0) {
      const msg = 'No saved WinRM connections configured. Use action="create" to add one.'
      emit(context, args, msg)
      return msg
    }
    const msg = `Saved WinRM connections (${entries.length}):\n${entries.map(summarize).join('\n')}`
    emit(context, args, msg)
    return msg
  }

  if (action === 'create') {
    if (!args.connection) {
      const msg = 'create requires a `connection` object with name, host, username, and password.'
      emit(context, args, msg)
      return msg
    }
    if (cm.listWinrm().some((e) => e.name === args.connection!.name)) {
      const msg = `A saved WinRM connection named "${args.connection.name}" already exists. Choose a unique name or use action="update".`
      emit(context, args, msg)
      return msg
    }
    const stored = cm.createWinrm(toEntry(args.connection, randomId()))
    const msg = `Created saved WinRM connection: ${summarize(stored)}. Open a tab with open_terminal_tab using Name "${stored.name}", then run commands with exec_command (command/response mode).`
    emit(context, args, msg)
    return msg
  }

  if (action === 'update') {
    if (!args.id || !args.connection) {
      const msg = 'update requires an `id` and a `connection` object with the fields to change.'
      emit(context, args, msg)
      return msg
    }
    const current = cm.listWinrm().find((e) => e.id === args.id)
    if (!current) {
      const msg = `No saved WinRM connection with id "${args.id}". Use action="list" to see valid ids.`
      emit(context, args, msg)
      return msg
    }
    const merged = { ...current, ...toEntry({ ...current, ...args.connection }, args.id) }
    const stored = cm.updateWinrm(merged)
    const msg = `Updated saved WinRM connection: ${summarize(stored)}.`
    emit(context, args, msg)
    return msg
  }

  if (action === 'delete') {
    if (!args.id) {
      const msg = 'delete requires an `id`.'
      emit(context, args, msg)
      return msg
    }
    const removed = cm.deleteWinrm(args.id)
    const msg = removed
      ? `Deleted saved WinRM connection id="${args.id}".`
      : `No saved WinRM connection with id="${args.id}" (nothing deleted).`
    emit(context, args, msg)
    return msg
  }

  const msg = `Unknown action "${action as string}".`
  emit(context, args, msg)
  return msg
}
