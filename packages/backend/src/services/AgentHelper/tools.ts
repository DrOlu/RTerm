import { convertToOpenAITool } from '@langchain/core/utils/function_calling'
import {
  editFile,
  editFileSchema,
  writeAndEdit,
  writeFile,
  writeFileSchema
} from './tools/edit_tools'
import { readFileSchema, runReadFile } from './tools/read_tools'
import { 
  execCommandSchema, 
  readTerminalTabSchema, 
  readCommandOutputSchema,
  writeStdinSchema,
  reconnectTerminalTabSchema,
  openTerminalTabSchema,
  runCommand, 
  runCommandNowait, 
  readTerminalTab, 
  readCommandOutput,
  writeStdin,
  reconnectTerminalTab,
  openTerminalTab
} from './tools/terminal_tools'
import { 
  BUILTIN_TOOL_INFO, 
  EDIT_FILE_TOOL_DESCRIPTION,
  WRITE_FILE_TOOL_DESCRIPTION,
  buildReadFileDescription,
  WAIT_TERMINAL_IDLE_DESCRIPTION
} from './prompts'
import { EDIT_FILE_TOOL_NAME, WRITE_FILE_TOOL_NAME } from './tool_capabilities'
import type { ReadFileSupport } from './types'
import { waitSchema, waitTerminalIdleSchema, wait, waitTerminalIdle } from './tools/wait_tools'
import {
  copyBetweenTabsSchema,
  readFileTransferStatusSchema,
  copyBetweenTabs,
  readFileTransferStatus
} from './tools/file_transfer_tools'
import {
  manageSshConnectionSchema,
  manageSshConnection
} from './tools/connection_tools'
import {
  manageWinrmConnectionSchema,
  manageWinrmConnection
} from './tools/winrm_connection_tools'
import {
  manageSerialConnectionSchema,
  manageSerialConnection
} from './tools/serial_connection_tools'
import {
  listSessionLogsSchema, readSessionLogSchema,
  listSessionLogs, readSessionLog,
} from './tools/session_log_tools'
import {
  runFleetCommandSchema,
  collectFactsSchema,
  probeConnectivitySchema,
  runFleetCommand,
  collectFacts,
  probeConnectivity
} from './tools/fleet_tools'
import {
  manageDeviceMemorySchema, manageDeviceMemory,
  manageScriptSchema, manageScript,
  manageGroupSchema, manageGroup,
  manageScheduledTaskSchema, manageScheduledTask,
  manageTemplateSchema, manageTemplate,
  importPuttySchema, importPutty,
} from './tools/automation_tools'
import { 
  skillToolSchema, 
  buildSkillToolDescription,
  createSkillSchema,
  runCreateSkillTool
} from './tools/skill_tools'

// Re-export schemas for AgentService to use
export { 
  editFileSchema, 
  writeAndEditSchema,
  writeFileSchema
} from './tools/edit_tools'

export { 
  execCommandSchema, 
  readTerminalTabSchema, 
  readCommandOutputSchema,
  writeStdinSchema,
  reconnectTerminalTabSchema,
  openTerminalTabSchema
} from './tools/terminal_tools'

export { readFileSchema } from './tools/read_tools'
export { waitSchema, waitTerminalIdleSchema } from './tools/wait_tools'
export { copyBetweenTabsSchema, readFileTransferStatusSchema } from './tools/file_transfer_tools'
export { manageSshConnectionSchema } from './tools/connection_tools'
export { manageWinrmConnectionSchema } from './tools/winrm_connection_tools'
export { manageSerialConnectionSchema } from './tools/serial_connection_tools'
export { listSessionLogsSchema, readSessionLogSchema } from './tools/session_log_tools'
export {
  runFleetCommandSchema,
  collectFactsSchema,
  probeConnectivitySchema,
} from './tools/fleet_tools'
export {
  manageDeviceMemorySchema, manageScriptSchema, manageGroupSchema,
  manageScheduledTaskSchema, manageTemplateSchema, importPuttySchema,
} from './tools/automation_tools'
export { skillToolSchema, createSkillSchema, buildSkillToolDescription } from './tools/skill_tools'

export { BUILTIN_TOOL_INFO } from './prompts'

export type { ToolExecutionContext, ReadFileSupport } from './types'

// Build Tool Definitions
export function buildToolsForModel(readFileSupport: ReadFileSupport) {
  return [
    {
      name: 'exec_command',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'exec_command')?.description ?? '',
      schema: execCommandSchema
    },
    {
      name: 'read_terminal_tab',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'read_terminal_tab')?.description ?? '',
      schema: readTerminalTabSchema
    },
    {
      name: 'read_command_output',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'read_command_output')?.description ?? '',
      schema: readCommandOutputSchema
    },
    {
      name: 'read_file',
      description: buildReadFileDescription(readFileSupport),
      schema: readFileSchema,
    },
    {
      name: 'write_stdin',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'write_stdin')?.description ?? '',
      schema: writeStdinSchema
    },
    {
      name: 'reconnect_terminal_tab',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'reconnect_terminal_tab')?.description ?? '',
      schema: reconnectTerminalTabSchema
    },
    {
      name: 'open_terminal_tab',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'open_terminal_tab')?.description ?? '',
      schema: openTerminalTabSchema
    },
    {
      name: WRITE_FILE_TOOL_NAME,
      description: WRITE_FILE_TOOL_DESCRIPTION,
      schema: writeFileSchema
    },
    {
      name: EDIT_FILE_TOOL_NAME,
      description: EDIT_FILE_TOOL_DESCRIPTION,
      schema: editFileSchema
    },
    {
      name: 'skill',
      description: buildSkillToolDescription([]), // Placeholder, will be updated by AgentService
      schema: skillToolSchema
    },
    {
      name: 'create_skill',
      description: 'Create a new skill in GyShell skills. This tool only creates new skills and does not modify or overwrite existing ones. If the skill name already exists, the call must fail and you should choose a different name. If you need to modify an existing skill, use edit_file to edit that skill\'s md file directly, or write_file only when intentionally replacing the full file.',
      schema: createSkillSchema
    },
    {
      name: 'wait',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'wait')?.description ?? '',
      schema: waitSchema
    },
    {
      name: 'wait_terminal_idle',
      description: WAIT_TERMINAL_IDLE_DESCRIPTION,
      schema: waitTerminalIdleSchema
    },
    {
      name: 'copy_between_tabs',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'copy_between_tabs')?.description ?? '',
      schema: copyBetweenTabsSchema
    },
    {
      name: 'read_file_transfer_status',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'read_file_transfer_status')?.description ?? '',
      schema: readFileTransferStatusSchema
    },
    {
      name: 'manage_ssh_connection',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'manage_ssh_connection')?.description ?? '',
      schema: manageSshConnectionSchema
    },
    {
      name: 'manage_winrm_connection',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'manage_winrm_connection')?.description ?? '',
      schema: manageWinrmConnectionSchema
    },
    {
      name: 'manage_serial_connection',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'manage_serial_connection')?.description ?? '',
      schema: manageSerialConnectionSchema
    },
    {
      name: 'list_session_logs',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'list_session_logs')?.description ?? '',
      schema: listSessionLogsSchema
    },
    {
      name: 'read_session_log',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'read_session_log')?.description ?? '',
      schema: readSessionLogSchema
    },
    {
      name: 'run_fleet_command',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'run_fleet_command')?.description ?? '',
      schema: runFleetCommandSchema
    },
    {
      name: 'collect_facts',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'collect_facts')?.description ?? '',
      schema: collectFactsSchema
    },
    {
      name: 'probe_connectivity',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'probe_connectivity')?.description ?? '',
      schema: probeConnectivitySchema
    },
    {
      name: 'manage_device_memory',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'manage_device_memory')?.description ?? '',
      schema: manageDeviceMemorySchema
    },
    {
      name: 'manage_script',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'manage_script')?.description ?? '',
      schema: manageScriptSchema
    },
    {
      name: 'manage_group',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'manage_group')?.description ?? '',
      schema: manageGroupSchema
    },
    {
      name: 'manage_scheduled_task',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'manage_scheduled_task')?.description ?? '',
      schema: manageScheduledTaskSchema
    },
    {
      name: 'manage_template',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'manage_template')?.description ?? '',
      schema: manageTemplateSchema
    },
    {
      name: 'import_putty',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'import_putty')?.description ?? '',
      schema: importPuttySchema
    }
  ].map((tool) => convertToOpenAITool(tool))
}

export const TOOLS_FOR_MODEL = buildToolsForModel({ image: false })

// Aggregated Tool Implementations
export const toolImplementations = {
  runCommand,
  runCommandNowait,
  readTerminalTab,
  readCommandOutput,
  writeStdin,
  reconnectTerminalTab,
  openTerminalTab,
  wait,
  waitTerminalIdle,
  copyBetweenTabs,
  readFileTransferStatus,
  manageSshConnection,
  manageWinrmConnection,
  manageSerialConnection,
  listSessionLogs,
  readSessionLog,
  runFleetCommand,
  collectFacts,
  probeConnectivity,
  manageDeviceMemory,
  manageScript,
  manageGroup,
  manageScheduledTask,
  manageTemplate,
  importPutty,
  writeFile,
  editFile,
  writeAndEdit,
  runReadFile,
  runCreateSkillTool
}
