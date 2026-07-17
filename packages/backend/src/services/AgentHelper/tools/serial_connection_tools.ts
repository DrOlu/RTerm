import { z } from 'zod'
import type { SerialConnectionEntry } from '../../../types'
import type { ToolExecutionContext } from '../types'

/**
 * `manage_serial_connection` — the agent can provision, edit, remove, and
 * list saved serial console connections (/dev/ttyUSB0, COM3, …). After
 * creating one, it opens a tab with open_terminal_tab and interacts with the
 * device (Cisco console, etc.) via write_stdin / read_terminal_tab — serial
 * IS a live byte-stream PTY (unlike WinRM).
 *
 * Mutations go through `IConnectionManagerRuntime` (backend SettingsService +
 * broadcast), so the Connections panel refreshes live.
 */

const serialConnectionFieldsSchema = z.object({
  name: z.string().min(1).describe('Display name; must be unique.'),
  path: z.string().min(1).describe('OS path to the serial device, e.g. /dev/ttyUSB0 or COM3.'),
  baudRate: z.number().int().min(1).default(9600),
  dataBits: z.enum(['5', '6', '7', '8']).optional().describe('Data bits (default 8).'),
  parity: z.enum(['none', 'even', 'odd']).optional().describe('Parity (default none).'),
  stopBits: z.enum(['1', '2']).optional().describe('Stop bits (default 1).'),
  flowControl: z
    .enum(['none', 'xon/xoff', 'rts/cts'])
    .optional()
    .describe('Flow control (default none).'),
  groupId: z.string().optional().describe('ID of a saved group/folder.'),
  notes: z.string().optional().describe('Free-form operator notes.'),
})

export const manageSerialConnectionSchema = z.object({
  action: z
    .enum(['create', 'update', 'delete', 'list'])
    .describe('create / update (by id) / delete (by id) / list saved serial connections.'),
  id: z.string().optional(),
  connection: serialConnectionFieldsSchema.optional(),
})

export type ManageSerialConnectionArgs = z.infer<typeof manageSerialConnectionSchema>

function emit(context: ToolExecutionContext, input: unknown, output: string): void {
  context.sendEvent(context.sessionId, {
    messageId: context.messageId,
    type: 'tool_call',
    toolName: 'manage_serial_connection',
    input: typeof input === 'string' ? input : JSON.stringify(input),
    output,
  })
}

function randomId(): string {
  return `serial-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function toEntry(fields: z.infer<typeof serialConnectionFieldsSchema>, id: string): SerialConnectionEntry {
  return {
    id,
    name: fields.name,
    path: fields.path,
    baudRate: fields.baudRate,
    dataBits: (fields.dataBits ? Number(fields.dataBits) : 8) as 5 | 6 | 7 | 8,
    parity: fields.parity,
    stopBits: (fields.stopBits ? Number(fields.stopBits) : 1) as 1 | 2,
    flowControl: fields.flowControl,
    groupId: fields.groupId,
    notes: fields.notes,
  }
}

function summarize(entry: SerialConnectionEntry): string {
  return `${entry.name} (id=${entry.id}, ${entry.path} @ ${entry.baudRate} baud)`
}

export async function manageSerialConnection(
  args: ManageSerialConnectionArgs,
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
    const entries = cm.listSerial()
    if (!entries.length) {
      const msg = 'No saved serial connections configured. Use action="create" to add one.'
      emit(context, args, msg)
      return msg
    }
    const msg = `Saved serial connections (${entries.length}):\n${entries.map(summarize).join('\n')}`
    emit(context, args, msg)
    return msg
  }

  if (action === 'create') {
    if (!args.connection) {
      const msg = 'create requires a `connection` object with name and path.'
      emit(context, args, msg)
      return msg
    }
    if (cm.listSerial().some((e) => e.name === args.connection!.name)) {
      const msg = `A saved serial connection named "${args.connection.name}" already exists. Choose a unique name or use action="update".`
      emit(context, args, msg)
      return msg
    }
    const stored = cm.createSerial(toEntry(args.connection, randomId()))
    const msg = `Created saved serial connection: ${summarize(stored)}. Open a tab with open_terminal_tab using Name "${stored.name}", then interact with write_stdin / read_terminal_tab.`
    emit(context, args, msg)
    return msg
  }

  if (action === 'update') {
    if (!args.id || !args.connection) {
      const msg = 'update requires an `id` and a `connection` object with the fields to change.'
      emit(context, args, msg)
      return msg
    }
    const current = cm.listSerial().find((e) => e.id === args.id)
    if (!current) {
      const msg = `No saved serial connection with id "${args.id}". Use action="list" to see valid ids.`
      emit(context, args, msg)
      return msg
    }
    const merged: SerialConnectionEntry = { ...current, ...toEntry({ ...current, ...args.connection } as z.infer<typeof serialConnectionFieldsSchema>, args.id) }
    const stored = cm.updateSerial(merged)
    const msg = `Updated saved serial connection: ${summarize(stored)}.`
    emit(context, args, msg)
    return msg
  }

  if (action === 'delete') {
    if (!args.id) {
      const msg = 'delete requires an `id`.'
      emit(context, args, msg)
      return msg
    }
    const removed = cm.deleteSerial(args.id)
    const msg = removed
      ? `Deleted saved serial connection id="${args.id}".`
      : `No saved serial connection with id="${args.id}" (nothing deleted).`
    emit(context, args, msg)
    return msg
  }

  const msg = `Unknown action "${action as string}".`
  emit(context, args, msg)
  return msg
}
