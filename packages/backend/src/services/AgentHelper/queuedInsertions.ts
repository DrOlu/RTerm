import { AGENT_NOTIFICATION_TAG } from './prompts'

export type QueuedAgentInsertionKind = 'exec_command_nowait_completed' | string

export interface QueuedAgentInsertionInput {
  kind: QueuedAgentInsertionKind
  content: string
  dedupeKey?: string
  originAgentRunId?: string
}

export interface QueuedAgentInsertion extends QueuedAgentInsertionInput {
  id: string
  sessionId: string
  agentRunId: string
  createdAt: number
}

export interface RunBackgroundExecCommandInput {
  terminalId: string
  terminalName: string
  historyCommandMatchId: string
  command: string
  originAgentRunId?: string
}

export interface RunBackgroundExecCommand extends RunBackgroundExecCommandInput {
  id: string
  sessionId: string
  agentRunId: string
  createdAt: number
  completedAt?: number
  exitCode?: number
  guardNotifiedAt?: number
}

export type QueuedAgentInsertionProvider = (
  sessionId: string,
  agentRunId: string
) => QueuedAgentInsertion[]
export type QueuedAgentInsertionAcknowledger = (
  sessionId: string,
  agentRunId: string,
  itemIds: string[]
) => void
export type QueuedAgentInsertionEnqueuer = (
  sessionId: string,
  insertion: QueuedAgentInsertionInput
) => void
export type RunBackgroundExecCommandRegistrar = (
  sessionId: string,
  command: RunBackgroundExecCommandInput
) => void
export type RunBackgroundExecCommandCompleter = (
  sessionId: string,
  command: RunBackgroundExecCommandInput & { exitCode?: number }
) => void
export type UnfinishedRunBackgroundExecCommandProvider = (
  sessionId: string,
  agentRunId: string
) => RunBackgroundExecCommand[]

export function buildQueuedInsertionBatchContent(items: QueuedAgentInsertion[]): string {
  return items
    .map((item) => item.content.trim())
    .filter(Boolean)
    .join('\n\n')
}

export function buildExecCommandNowaitCompletedInsertion(params: {
  terminalId: string
  terminalName: string
  historyCommandMatchId: string
  command: string
  exitCode?: number
}): QueuedAgentInsertionInput {
  const terminalRef = params.terminalId || params.terminalName
  const instruction =
    'The nowait exec_command has completed. Do not infer or summarize command output from this notification. ' +
    `Use read_command_output with tabIdOrName=${JSON.stringify(terminalRef)} and history_command_match_id=${JSON.stringify(params.historyCommandMatchId)} if you need to inspect the result.`
  const payload = {
    notification_type: 'exec_command_nowait_completed',
    message: 'A background nowait exec_command has completed.',
    history_command_match_id: params.historyCommandMatchId,
    terminal_id: params.terminalId,
    terminal_name: params.terminalName,
    tool: 'exec_command',
    execution_mode: 'nowait',
    ...(typeof params.exitCode === 'number' ? { exit_code: params.exitCode } : {}),
    command: params.command,
    instruction
  }
  const content = `${AGENT_NOTIFICATION_TAG}${JSON.stringify(payload, null, 2)}`
  return {
    kind: 'exec_command_nowait_completed',
    content,
    dedupeKey: `exec_command_nowait_completed:${params.terminalId}:${params.historyCommandMatchId}`
  }
}

export function buildUnfinishedExecCommandContinueInstruction(commands: RunBackgroundExecCommand[]): string {
  const commandLines = commands.map((command, index) => {
    const terminalRef = command.terminalId || command.terminalName
    return [
      `${index + 1}. command=${JSON.stringify(command.command)}`,
      `   terminalId=${JSON.stringify(command.terminalId)}`,
      `   terminalName=${JSON.stringify(command.terminalName)}`,
      `   history_command_match_id=${JSON.stringify(command.historyCommandMatchId)}`,
      `   suggested read_command_output args: tabIdOrName=${JSON.stringify(terminalRef)}, history_command_match_id=${JSON.stringify(command.historyCommandMatchId)}`
    ].join('\n')
  })

  return [
    'You previously started one or more exec_command tasks in background/nowait mode, and they have not finished yet.',
    'Before ending this turn, inspect their current progress and decide whether you should wait longer, take another action, or explicitly proceed without waiting.',
    'Use read_command_output with the provided history_command_match_id and terminal id/name. Do not assume the command output or final status.',
    '',
    'Unfinished background exec_command tasks:',
    ...commandLines
  ].join('\n')
}
