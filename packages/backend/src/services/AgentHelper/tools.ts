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
  listSessionLogsSchema, readSessionLogSchema, searchSessionLogsSchema,
  listSessionLogs, readSessionLog, searchSessionLogs,
} from './tools/session_log_tools'
import {
  getRunLedgerSchema,
  getRunLedger,
} from './tools/run_ledger_tools'
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
  managePlaybookSchema, managePlaybook,
  runPlaybookSchema, runPlaybook,
} from './tools/playbook_tools'
import { manageChangeSchema, manageChange } from './tools/change_tools'
import { manageTriggerSchema, manageTrigger } from './tools/trigger_tools'
import {
  getMetricsSchema, getMetrics,
  manageSecretSchema, manageSecret,
  manageOncallSchema, manageOncall,
  getCostSchema, getCost,
  manageRecordingSchema, manageRecording,
  manageGitopsSchema, manageGitops,
  managePlaybookVersionSchema, managePlaybookVersion,
  getCloudInventorySchema, getCloudInventory,
  getLiveDashboardSchema, getLiveDashboard,
  ingestApmSpansSchema, ingestApmSpans,
  getApmSummarySchema, getApmSummary,
  ingestDemBeaconSchema, ingestDemBeacon,
  getDemSummarySchema, getDemSummary,
  collectInfraSchema, collectInfra,
  manageEtwSchema, manageEtw,
  listGatewayMethodsSchema, listGatewayMethods,
} from './tools/observability_tools'
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
export { listSessionLogsSchema, readSessionLogSchema, searchSessionLogsSchema } from './tools/session_log_tools'
export { getRunLedgerSchema } from './tools/run_ledger_tools'
export {
  runFleetCommandSchema,
  collectFactsSchema,
  probeConnectivitySchema,
} from './tools/fleet_tools'
export {
  manageDeviceMemorySchema, manageScriptSchema, manageGroupSchema,
  manageScheduledTaskSchema, manageTemplateSchema, importPuttySchema,
} from './tools/automation_tools'
export { managePlaybookSchema, runPlaybookSchema } from './tools/playbook_tools'
export { manageChangeSchema } from './tools/change_tools'
export { manageTriggerSchema } from './tools/trigger_tools'
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
      name: 'search_session_logs',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'search_session_logs')?.description ?? '',
      schema: searchSessionLogsSchema
    },
    {
      name: 'get_run_ledger',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'get_run_ledger')?.description ?? '',
      schema: getRunLedgerSchema
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
      name: 'manage_playbook',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'manage_playbook')?.description ?? '',
      schema: managePlaybookSchema
    },
    {
      name: 'run_playbook',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'run_playbook')?.description ?? '',
      schema: runPlaybookSchema
    },
    {
      name: 'manage_change',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'manage_change')?.description ?? '',
      schema: manageChangeSchema
    },
    {
      name: 'manage_trigger',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'manage_trigger')?.description ?? '',
      schema: manageTriggerSchema
    },
    {
      name: 'import_putty',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'import_putty')?.description ?? '',
      schema: importPuttySchema
    },
    {
      name: 'get_metrics',
      description: 'Read host metrics as Prometheus exposition text (for a scraper) or a one-line dashboard summary. Use to answer "how are my hosts doing" or to feed an external Prometheus/OTel collector.',
      schema: getMetricsSchema
    },
    {
      name: 'manage_secret',
      description: 'Manage the encrypted secrets vault — list metadata (never values), set, delete, or check a secret. Secrets are materialized only at exec time and never enter the conversation. Vault must be unlocked (RTERM_SECRETS_MASTER_KEY).',
      schema: manageSecretSchema
    },
    {
      name: 'manage_oncall',
      description: 'Incident on-call paging — list open pages, raise a page for an incident under an escalation policy, acknowledge or resolve a page, list policies, or advance the escalation clock.',
      schema: manageOncallSchema
    },
    {
      name: 'get_cost',
      description: 'AI cost & budgets — summarize token spend in dollars (per model/profile, daily/monthly), check an intended run against budgets (ok/warn/throttle/deny), or list budgets.',
      schema: getCostSchema
    },
    {
      name: 'manage_recording',
      description: 'asciinema-style session recording — list, start, stop, replay (scrub), export (.cast), or delete a terminal session recording.',
      schema: manageRecordingSchema
    },
    {
      name: 'manage_gitops',
      description: 'GitOps for desired state — export the live estate (connections/playbooks/triggers/etc.) as a content-hashed manifest, or detect drift / verify a manifest against live.',
      schema: manageGitopsSchema
    },
    {
      name: 'manage_playbook_version',
      description: 'Playbook/runbook versioning + lint — statically lint a playbook definition (undefined params, dependsOn cycles, empty steps, missing rollback), list version history, roll back, or diff two versions.',
      schema: managePlaybookVersionSchema
    },
    {
      name: 'get_cloud_inventory',
      description: 'Cloud resource inventory (AWS/GCP/Azure) — summary counts by provider/state, query instances (filter by provider/state/region), or pull fresh inventory.',
      schema: getCloudInventorySchema
    },
    {
      name: 'get_live_dashboard',
      description: 'Live multi-client dashboard — read the current unified dashboard state/summary, or the number of connected dashboard subscribers.',
      schema: getLiveDashboardSchema
    },
    {
      name: 'list_gateway_methods',
      description: 'API self-discovery — list the WebSocket gateway RPC methods (names, categories, descriptions, params) from the shared registry. Optionally filter by category or name prefix. Use to answer "what can the gateway do?" accurately instead of guessing method names.',
      schema: listGatewayMethodsSchema
    },
    {
      name: 'ingest_apm_spans',
      description: 'Ingest OTLP/HTTP-JSON distributed-trace spans into the APM trace store (feeds bottleneck/slowest-trace analysis and the dashboard APM section).',
      schema: ingestApmSpansSchema
    },
    {
      name: 'get_apm_summary',
      description: 'Read the APM summary — traces, spans, per-service error rates and p95 latency.',
      schema: getApmSummarySchema
    },
    {
      name: 'ingest_dem_beacon',
      description: 'Ingest a Core Web Vitals RUM beacon (page, LCP/INP/CLS/TTFB, JS errors) into the DEM store (feeds per-page p75 + error rate and the dashboard DEM section).',
      schema: ingestDemBeaconSchema
    },
    {
      name: 'get_dem_summary',
      description: 'Read the DEM summary — sessions, pages, p75 Core Web Vitals, error rate.',
      schema: getDemSummarySchema
    },
    {
      name: 'collect_infra',
      description: 'Collect Kubernetes cluster health — runs `kubectl get pods -A -o json` (or accepts the payload), feeds the infra monitor (pod readiness, restarts, CrashLoopBackOff).',
      schema: collectInfraSchema
    },
    {
      name: 'manage_etw',
      description: 'Windows ETW diagnostics — start/stop a trace (logman), parse captured Get-WinEvent/Get-Counter output, list sessions. Use against a Windows host for network/file/registry/process/DNS diagnostics.',
      schema: manageEtwSchema
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
  searchSessionLogs,
  getRunLedger,
  runFleetCommand,
  collectFacts,
  probeConnectivity,
  manageDeviceMemory,
  manageScript,
  manageGroup,
  manageScheduledTask,
  manageTemplate,
  managePlaybook,
  runPlaybook,
  manageChange,
  manageTrigger,
  importPutty,
  getMetrics,
  manageSecret,
  manageOncall,
  getCost,
  manageRecording,
  manageGitops,
  managePlaybookVersion,
  getCloudInventory,
  getLiveDashboard,
  ingestApmSpans,
  getApmSummary,
  ingestDemBeacon,
  getDemSummary,
  collectInfra,
  manageEtw,
  listGatewayMethods,
  writeFile,
  editFile,
  writeAndEdit,
  runReadFile,
  runCreateSkillTool
}
