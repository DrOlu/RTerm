import { z } from 'zod'
import type { SSHConnectionEntry } from '../../../types'
import type { ToolExecutionContext } from '../types'

/**
 * `manage_ssh_connection` — the agent can provision, edit, remove, and list
 * saved SSH connections exactly like the Connections panel does. This is the
 * key that unlocks autonomous "set up server X and connect to it" workflows:
 * the agent creates the connection, then opens a tab from it with
 * `open_terminal_tab`, all in one turn.
 *
 * Mutations go through `IConnectionManagerRuntime` (backend SettingsService +
 * broadcast), so the UI's Connections list refreshes live and the agent's
 * own `savedSshConnections` snapshot is refreshed on the next turn.
 */

const sshConnectionFieldsSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('Display name shown in the Connections panel and used by open_terminal_tab. Must be unique.'),
  host: z.string().min(1).describe('Hostname or IP address of the SSH target.'),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).describe('SSH login user.'),
  authMethod: z.enum(['password', 'privateKey']).default('password'),
  password: z
    .string()
    .optional()
    .describe('Password for authMethod=password. Leave undefined for key auth.'),
  privateKey: z
    .string()
    .optional()
    .describe('PEM private key contents for authMethod=privateKey.'),
  privateKeyPath: z
    .string()
    .optional()
    .describe('Path to a PEM private key file for authMethod=privateKey.'),
  passphrase: z.string().optional().describe('Passphrase for an encrypted private key.'),
  proxyId: z.string().optional().describe('ID of a saved SOCKS/HTTP proxy to tunnel through.'),
  tunnelIds: z.array(z.string()).optional().describe('IDs of saved SSH tunnels to chain through.'),
  /**
   * jumpHost is intentionally omitted from the agent schema to keep the
   * payload flat and avoid nested-object ambiguity; multi-hop can still be
   * modelled by first creating the jump host connection, then referencing it
   * if a future schema revision adds `jumpHostId`.
   */
  algorithmsPreset: z
    .enum(['modern', 'legacy', 'cisco'])
    .optional()
    .describe(
      'SSH algorithm preset. Use "cisco" for IOS/IOS-XE network gear, "legacy" for other old devices, omit/\"modern\" for normal Linux/Windows servers.',
    ),
  termType: z
    .string()
    .optional()
    .describe('TERM value for the remote PTY (e.g. "vt100" for some network equipment).'),
})

export const manageSshConnectionSchema = z.object({
  action: z
    .enum(['create', 'update', 'delete', 'list'])
    .describe(
      'create = add a new saved connection; update = edit an existing one (by id); delete = remove one (by id); list = return all saved connections.',
    ),
  /** Used by update/delete to identify the target. */
  id: z
    .string()
    .optional()
    .describe('ID of the connection to update or delete. Required for update/delete.'),
  /** Connection fields. Required for create; for update, only provided fields are applied. */
  connection: sshConnectionFieldsSchema.optional(),
})

export type ManageSshConnectionArgs = z.infer<typeof manageSshConnectionSchema>

function emitToolEvent(
  context: ToolExecutionContext,
  toolName: string,
  input: unknown,
  output: string,
): void {
  context.sendEvent(context.sessionId, {
    messageId: context.messageId,
    type: 'tool_call',
    toolName,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    output,
  })
}

function randomId(): string {
  // Lightweight unique id (matches the UI's uuid style without importing uuid here).
  return `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function toEntry(
  fields: z.infer<typeof sshConnectionFieldsSchema>,
  id: string,
): SSHConnectionEntry {
  return {
    id,
    name: fields.name,
    host: fields.host,
    port: fields.port,
    username: fields.username,
    authMethod: fields.authMethod,
    password: fields.password,
    privateKey: fields.privateKey,
    privateKeyPath: fields.privateKeyPath,
    passphrase: fields.passphrase,
    proxyId: fields.proxyId,
    tunnelIds: fields.tunnelIds,
    algorithmsPreset: fields.algorithmsPreset,
    termType: fields.termType,
  }
}

function summarize(entry: SSHConnectionEntry): string {
  const preset = entry.algorithmsPreset ? `, preset=${entry.algorithmsPreset}` : ''
  const term = entry.termType ? `, TERM=${entry.termType}` : ''
  return `${entry.name} (id=${entry.id}, ${entry.username}@${entry.host}:${entry.port}, auth=${entry.authMethod}${preset}${term})`
}

export async function manageSshConnection(
  args: ManageSshConnectionArgs,
  context: ToolExecutionContext,
): Promise<string> {
  const { connectionManager } = context
  if (!connectionManager) {
    const msg =
      'Connection management is not available in this runtime (no connection manager wired).'
    emitToolEvent(context, 'manage_ssh_connection', args, msg)
    return msg
  }

  const { action } = args

  if (action === 'list') {
    const entries = connectionManager.listSsh()
    if (entries.length === 0) {
      const msg = 'No saved SSH connections configured. Use action="create" to add one.'
      emitToolEvent(context, 'manage_ssh_connection', args, msg)
      return msg
    }
    const body = entries.map(summarize).join('\n')
    const msg = `Saved SSH connections (${entries.length}):\n${body}`
    emitToolEvent(context, 'manage_ssh_connection', args, msg)
    return msg
  }

  if (action === 'create') {
    if (!args.connection) {
      const msg = 'create requires a `connection` object with name, host, and username.'
      emitToolEvent(context, 'manage_ssh_connection', args, msg)
      return msg
    }
    // Reject duplicate names so open_terminal_tab name-matching stays unambiguous.
    const existing = connectionManager.listSsh()
    if (existing.some((e) => e.name === args.connection!.name)) {
      const msg = `A saved connection named "${args.connection.name}" already exists. Choose a unique name or use action="update".`
      emitToolEvent(context, 'manage_ssh_connection', args, msg)
      return msg
    }
    const entry = toEntry(args.connection, randomId())
    const stored = connectionManager.createSsh(entry)
    const msg = `Created saved SSH connection: ${summarize(stored)}. You can now open a terminal tab for it with open_terminal_tab using Name "${stored.name}".`
    emitToolEvent(context, 'manage_ssh_connection', args, msg)
    return msg
  }

  if (action === 'update') {
    if (!args.id) {
      const msg = 'update requires an `id` of the connection to modify.'
      emitToolEvent(context, 'manage_ssh_connection', args, msg)
      return msg
    }
    if (!args.connection) {
      const msg = 'update requires a `connection` object with the fields to change.'
      emitToolEvent(context, 'manage_ssh_connection', args, msg)
      return msg
    }
    const existing = connectionManager.listSsh()
    const current = existing.find((e) => e.id === args.id)
    if (!current) {
      const msg = `No saved SSH connection with id "${args.id}". Use action="list" to see valid ids.`
      emitToolEvent(context, 'manage_ssh_connection', args, msg)
      return msg
    }
    // Merge provided fields over the existing entry (partial update).
    const merged: SSHConnectionEntry = {
      ...current,
      ...toEntry({ ...current, ...args.connection }, args.id),
    }
    const stored = connectionManager.updateSsh(merged)
    const msg = `Updated saved SSH connection: ${summarize(stored)}.`
    emitToolEvent(context, 'manage_ssh_connection', args, msg)
    return msg
  }

  if (action === 'delete') {
    if (!args.id) {
      const msg = 'delete requires an `id` of the connection to remove.'
      emitToolEvent(context, 'manage_ssh_connection', args, msg)
      return msg
    }
    const removed = connectionManager.deleteSsh(args.id)
    const msg = removed
      ? `Deleted saved SSH connection id="${args.id}".`
      : `No saved SSH connection with id="${args.id}" (nothing deleted).`
    emitToolEvent(context, 'manage_ssh_connection', args, msg)
    return msg
  }

  // Unreachable: schema restricts action to the four handled values.
  const msg = `Unknown action "${action as string}".`
  emitToolEvent(context, 'manage_ssh_connection', args, msg)
  return msg
}
