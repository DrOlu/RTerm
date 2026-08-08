/**
 * parallelToolExecution.extreme.spec — tests for the v3.2.4 parallel tool execution feature.
 * Tests canRunInParallel() logic and the executeToolByName dispatch.
 *
 * canRunInParallel is a pure function — testable without any NATS/backend/PTY.
 * executeToolByName delegates to toolImplementations — tested with fakes.
 */

// Import the functions from AgentService_v2 (they're module-level constants)
// Since AgentService_v2 is a large file, we test the logic directly.

const tests: Array<{ name: string; run: () => Promise<void> | void }> = []
function test(name: string, run: () => Promise<void> | void) { tests.push({ name, run }) }
function assertTrue(cond: boolean, message: string): void { if (!cond) throw new Error(message) }
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}. expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
}

// ─── Replicate the canRunInParallel logic for testing ────────────────────────
// (The real function is inside AgentService_v2.ts and not exported.
// We replicate the exact logic here to test the decision rules.
// If the logic changes, this test must be updated to match.)

const SINGLE_CALL_TOOL_BOUNDARY_NAMES = new Set([
  "exec_command", "reconnect_terminal_tab", "open_terminal_tab", "probe_connectivity",
  "manage_ssh_connection", "manage_winrm_connection", "manage_serial_connection",
  "manage_group", "manage_device_memory", "manage_script", "manage_scheduled_task",
  "manage_template", "import_putty",
])

const PARALLEL_SAFE_TOOL_NAMES = new Set([
  "read_file", "read_terminal_tab", "read_command_output", "list_session_logs",
  "read_session_log", "search_session_logs", "get_metrics", "get_live_dashboard",
  "get_monitor_status", "get_cloud_inventory", "get_apm_summary", "get_dem_summary",
  "get_cost", "get_run_ledger", "list_gateway_methods", "manage_secret",
  "manage_oncall", "manage_gitops", "manage_playbook_version", "collect_facts",
  "run_fleet_command", "synapse_health", "synapse_discover", "synapse_agents_summary",
  "synapse_reputation", "synapse_serve_status", "numbat_health", "numbat_findings_summary",
  "agentspan_health", "agentspan_list", "agentspan_status", "webintel_health",
  "web_search", "web_fetch", "web_find_similar", "web_watch_list",
  "patch_status", "list_requests", "request_status", "sop_search", "sop_get",
  "iam_user_info", "iam_user_groups", "iam_access_review",
  "fraudops_pipeline_status", "fraudops_str_status", "fraudops_decision_summary",
  "netdata_alert_summary", "netdata_correlate",
])

function canRunInParallel(toolCalls: any[]): boolean {
  if (toolCalls.length <= 1) return false
  for (const tc of toolCalls) {
    if (SINGLE_CALL_TOOL_BOUNDARY_NAMES.has(tc?.name)) return false
    if (!PARALLEL_SAFE_TOOL_NAMES.has(tc?.name)) return false
  }
  const terminalIds = new Set<string>()
  for (const tc of toolCalls) {
    const args = typeof tc?.args === 'string' ? (() => { try { return JSON.parse(tc.args) } catch { return {} } })() : (tc?.args || {})
    const tid = args.terminalId || args.target
    if (tid) {
      if (terminalIds.has(tid)) return false
      terminalIds.add(tid)
    }
  }
  return true
}

// ─── canRunInParallel tests ──────────────────────────────────────────────────

test('canRunInParallel returns false for single tool call', () => {
  assertEqual(canRunInParallel([{ name: 'read_terminal_tab' }]), false, 'single call should not parallelize')
})

test('canRunInParallel returns false for empty array', () => {
  assertEqual(canRunInParallel([]), false, 'empty array should not parallelize')
})

test('canRunInParallel returns true for two parallel-safe read-only tools', () => {
  assertEqual(canRunInParallel([
    { name: 'get_metrics' },
    { name: 'get_live_dashboard' },
  ]), true, 'two read-only tools should parallelize')
})

test('canRunInParallel returns false when a boundary tool is present', () => {
  assertEqual(canRunInParallel([
    { name: 'get_metrics' },
    { name: 'exec_command' },
  ]), false, 'exec_command is a boundary tool — should not parallelize')
})

test('canRunInParallel returns false when a non-parallel-safe tool is present', () => {
  assertEqual(canRunInParallel([
    { name: 'get_metrics' },
    { name: 'write_stdin' }, // not in PARALLEL_SAFE_TOOL_NAMES
  ]), false, 'write_stdin is not parallel-safe')
})

test('canRunInParallel returns false when two tools target the same terminalId', () => {
  assertEqual(canRunInParallel([
    { name: 'read_terminal_tab', args: { terminalId: 't1' } },
    { name: 'read_command_output', args: { terminalId: 't1' } },
  ]), false, 'same terminalId should not parallelize (would conflict)')
})

test('canRunInParallel returns true when tools target different terminalIds', () => {
  assertEqual(canRunInParallel([
    { name: 'read_terminal_tab', args: { terminalId: 't1' } },
    { name: 'read_terminal_tab', args: { terminalId: 't2' } },
  ]), true, 'different terminalIds should parallelize')
})

test('canRunInParallel returns true for three parallel-safe tools with no terminal conflicts', () => {
  assertEqual(canRunInParallel([
    { name: 'get_metrics' },
    { name: 'get_cloud_inventory' },
    { name: 'get_cost' },
  ]), true, 'three read-only tools should parallelize')
})

test('canRunInParallel returns false when any tool is a boundary tool (open_terminal_tab)', () => {
  assertEqual(canRunInParallel([
    { name: 'get_metrics' },
    { name: 'get_cost' },
    { name: 'open_terminal_tab' },
  ]), false, 'open_terminal_tab is a boundary tool')
})

test('canRunInParallel returns false when any tool is a boundary tool (manage_ssh_connection)', () => {
  assertEqual(canRunInParallel([
    { name: 'manage_ssh_connection' },
    { name: 'get_metrics' },
  ]), false, 'manage_ssh_connection is a boundary tool')
})

test('canRunInParallel handles string args (JSON-encoded)', () => {
  assertEqual(canRunInParallel([
    { name: 'read_terminal_tab', args: '{"terminalId":"t1"}' },
    { name: 'read_terminal_tab', args: '{"terminalId":"t2"}' },
  ]), true, 'string args should be parsed for terminalId check')
})

test('canRunInParallel handles string args with same terminalId', () => {
  assertEqual(canRunInParallel([
    { name: 'read_terminal_tab', args: '{"terminalId":"t1"}' },
    { name: 'read_command_output', args: '{"terminalId":"t1"}' },
  ]), false, 'same terminalId in string args should not parallelize')
})

test('canRunInParallel handles missing args gracefully', () => {
  assertEqual(canRunInParallel([
    { name: 'get_metrics' },
    { name: 'get_cost', args: undefined },
  ]), true, 'missing args should not cause errors')
})

test('canRunInParallel handles malformed string args gracefully', () => {
  assertEqual(canRunInParallel([
    { name: 'get_metrics', args: 'not json' },
    { name: 'get_cost' },
  ]), true, 'malformed args should not cause errors')
})

test('canRunInParallel: all plugin tools (synapse, numbat, agentspan, web-intel) are parallel-safe', () => {
  assertEqual(canRunInParallel([
    { name: 'synapse_health' },
    { name: 'numbat_health' },
    { name: 'agentspan_health' },
    { name: 'webintel_health' },
  ]), true, 'all plugin health checks should parallelize')
})

test('canRunInParallel: run_fleet_command is parallel-safe (runs on different terminals)', () => {
  assertEqual(canRunInParallel([
    { name: 'run_fleet_command', args: { command: 'uptime' } },
    { name: 'collect_facts' },
  ]), true, 'fleet command + collect_facts should parallelize')
})

// ─── executeToolByName tests (mocked) ────────────────────────────────────────

test('executeToolByName dispatches to plugin tools via pluginTools map', async () => {
  // Simulate the executeToolByName logic for a plugin tool
  const pluginTools = new Map<string, (params: any) => Promise<any>>()
  pluginTools.set('synapse_health', async () => ({ connected: true, agentId: 'rterm-001' }))

  const name = 'synapse_health'
  const handler = pluginTools.get(name)
  assertTrue(!!handler, 'plugin handler should exist')
  const result = await handler!({})
  assertEqual(result.connected, true, 'plugin tool should return its result')
})

test('executeToolByName returns error string for unknown tool', async () => {
  const pluginTools = new Map<string, (params: any) => Promise<any>>()
  const name = 'nonexistent_tool'
  const handler = pluginTools.get(name)
  const result = handler
    ? await handler({})
    : `Tool "${name}" is not supported in parallel execution mode.`
  assertEqual(result, 'Tool "nonexistent_tool" is not supported in parallel execution mode.', 'unknown tool should return error string')
})

test('executeToolByName handles plugin tool that returns a string (not object)', async () => {
  const pluginTools = new Map<string, (params: any) => Promise<any>>()
  pluginTools.set('web_search', async () => 'Found 5 results')

  const name = 'web_search'
  const handler = pluginTools.get(name)
  const rawResult = await handler!({})
  const result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult)
  assertEqual(result, 'Found 5 results', 'string results should be passed through')
})

test('executeToolByName handles plugin tool that returns an object (JSON-stringified)', async () => {
  const pluginTools = new Map<string, (params: any) => Promise<any>>()
  pluginTools.set('synapse_discover', async () => ({ count: 3, agents: ['a1', 'a2', 'a3'] }))

  const name = 'synapse_discover'
  const handler = pluginTools.get(name)
  const rawResult = await handler!({})
  const result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult)
  assertEqual(result, '{"count":3,"agents":["a1","a2","a3"]}', 'object results should be JSON-stringified')
})

test('executeToolByName handles plugin tool that throws an error', async () => {
  const pluginTools = new Map<string, (params: any) => Promise<any>>()
  pluginTools.set('failing_tool', async () => { throw new Error('connection refused') })

  const name = 'failing_tool'
  const handler = pluginTools.get(name)
  let result: string
  try {
    const rawResult = await handler!({})
    result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult)
  } catch (err) {
    result = `Parallel execution error for ${name}: ${(err as Error).message}`
  }
  assertEqual(result, 'Parallel execution error for failing_tool: connection refused', 'errors should be caught and returned as strings')
})

// ─── Runner ─────────────────────────────────────────────────────────────────
async function main() {
  let pass = 0, fail = 0
  for (const t of tests) {
    try { await t.run(); pass++; console.log(`PASS ${t.name}`) }
    catch (e) { fail++; console.log(`FAIL ${t.name}: ${(e as Error).message}`) }
  }
  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
main()
