import { z } from 'zod'
import type { CommandResult, TerminalTab } from '../../../types'
import type { ToolExecutionContext } from '../types'
import {
  resolveTerminalForTool,
  formatTerminalStatusHeader,
} from './terminal_runtime_guard'
import {
  checkCommandPolicy,
  resolveSavedSshConnection,
  sshEntryToTerminalConfig,
  abortIfNeeded,
  isAbortError,
  waitWithSignal,
} from './terminal_tools'

/**
 * Fleet tools — the multiplicative agentic layer that lets the agent operate
 * across many open terminals at once (parallel command execution + structured
 * aggregation, per-OS fact collection, and reachability probing). They build
 * on the existing single-tab primitives (runCommand, open_terminal_tab, the
 * command-policy guardrail) rather than replacing them, so guardrails still
 * apply and the agent can compose fleet ops with everything else.
 */

const MAX_FLEET_TARGETS = 25
const PROBE_READY_TIMEOUT_MS = 30000
const PROBE_READY_POLL_MS = 500

// --- run_fleet_command ---

export const runFleetCommandSchema = z.object({
  targets: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_FLEET_TARGETS)
    .describe(
      'Names or IDs of OPEN terminal tabs to run the command on. Each must already be open (use open_terminal_tab first). Duplicates are ignored.',
    ),
  command: z.string().min(1).describe('The command to run on every target tab.'),
})

export type RunFleetCommandArgs = z.infer<typeof runFleetCommandSchema>

interface FleetTargetResult {
  target: string
  ok: boolean
  exitCode?: number
  output: string
}

async function runOnOneTab(
  tab: TerminalTab,
  command: string,
  context: ToolExecutionContext,
): Promise<FleetTargetResult> {
  const label = tab.title || tab.id
  try {
    abortIfNeeded(context.signal)
    // The command is identical across the fleet; the command policy is checked
    // once for the whole fleet (below) before fan-out, so we pass 'allow'
    // through here by calling the lower-level runCommandAndWait directly.
    const result: CommandResult = await context.terminalService.runCommandAndWait(
      tab.id,
      command,
      { signal: context.signal, interruptOnAbort: false },
    )
    return {
      target: label,
      ok: true,
      exitCode: result.exitCode,
      output: truncateForFleet(result.stdoutDelta || ''),
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    const message = error instanceof Error ? error.message : String(error)
    return { target: label, ok: false, output: truncateForFleet(message) }
  }
}

function truncateForFleet(output: string, max = 2000): string {
  if (output.length <= max) return output
  const head = output.slice(0, Math.floor(max / 2))
  const tail = output.slice(-Math.floor(max / 2))
  return `${head}\n…[truncated ${output.length - max} chars]…\n${tail}`
}

export async function runFleetCommand(
  args: RunFleetCommandArgs,
  context: ToolExecutionContext,
): Promise<string> {
  const { targets, command } = args
  const { sessionId, messageId, sendEvent } = context

  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_started',
    toolName: 'run_fleet_command',
    title: `Fleet: ${targets.length} target(s)`,
    hint: command,
    input: JSON.stringify(args),
  })
  const finish = (output: string): string => {
    sendEvent(sessionId, { messageId, type: 'sub_tool_delta', outputDelta: output })
    sendEvent(sessionId, { messageId, type: 'sub_tool_finished' })
    return output
  }

  // Resolve + dedupe targets first so we never run the same tab twice.
  const resolved = []
  const seenIds = new Set<string>()
  const resolveErrors: FleetTargetResult[] = []
  for (const raw of targets) {
    const r = resolveTerminalForTool(context, raw)
    if (!r.ok) {
      resolveErrors.push({ target: raw, ok: false, output: r.message })
      continue
    }
    if (seenIds.has(r.terminal.id)) continue
    seenIds.add(r.terminal.id)
    if (!r.snapshot.canRunCommand) {
      resolveErrors.push({
        target: r.terminal.title || r.terminal.id,
        ok: false,
        output: `Tab not ready for commands (${r.snapshot.runtimeState}).`,
      })
      continue
    }
    resolved.push(r.terminal)
  }

  // Guardrail: evaluate the command policy once for the whole fleet. A single
  // approval covers every target, which is the right UX for fleet operations.
  if (resolved.length > 0) {
    const policy = await checkCommandPolicy(command, 'run_fleet_command', context)
    if (!policy.allowed) {
      const body = serializeResults([
        ...resolveErrors,
        ...resolved.map((t) => ({
          target: t.title || t.id,
          ok: false,
          output: `Blocked by command policy: ${policy.message}`,
        })),
      ])
      return finish(
        `Fleet command blocked by policy for all ${resolved.length} target(s).\n${body}`,
      )
    }
  }

  // Fan out in parallel, collect structured results.
  const execResults = await Promise.allSettled(
    resolved.map((tab) => runOnOneTab(tab, command, context)),
  )
  const allResults: FleetTargetResult[] = [...resolveErrors]
  execResults.forEach((r) => {
    if (r.status === 'fulfilled') allResults.push(r.value)
    else {
      const err = r.reason instanceof Error ? r.reason.message : String(r.reason)
      allResults.push({ target: '(unknown)', ok: false, output: truncateForFleet(err) })
    }
  })

  const okCount = allResults.filter((r) => r.ok).length
  const summary = `Fleet command finished on ${allResults.length} target(s): ${okCount} ok, ${
    allResults.length - okCount
  } failed/errored.`
  return finish(`${summary}\n${serializeResults(allResults)}`)
}

function serializeResults(results: FleetTargetResult[]): string {
  // Structured, machine-parseable block so the agent can reason over the fleet
  // outcome (e.g. "list which targets failed" or "re-run on failures").
  const lines = results.map((r) => {
    const status = r.ok ? 'OK' : 'FAIL'
    const code = typeof r.exitCode === 'number' ? ` exit=${r.exitCode}` : ''
    return `### ${r.target} [${status}${code}]\n${r.output || '(no output)'}`
  })
  return `<fleet_results count="${results.length}">\n${lines.join('\n\n')}\n</fleet_results>`
}

// --- collect_facts ---

export const collectFactsSchema = z.object({
  targets: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_FLEET_TARGETS)
    .optional()
    .describe(
      'Names/IDs of OPEN tabs to inventory. Omit to inventory ALL currently-open tabs.',
    ),
  /** Hint to classify a target's OS when the backend can't detect it. */
  defaultClass: z
    .enum(['network', 'linux', 'windows'])
    .optional()
    .describe(
      'Classification hint for targets whose OS the backend could not auto-detect (e.g. raw-shell Cisco tabs). "network" = IOS/IOS-XE, "linux" = POSIX server, "windows" = Windows server.',
    ),
})

export type CollectFactsArgs = z.infer<typeof collectFactsSchema>

/**
 * Per-class fact templates. Kept deliberately small and POSIX/cisco-CLI
 * portable so they succeed on the widest range of targets. The agent can
 * always follow up with targeted commands via run_fleet_command.
 */
const FACT_TEMPLATES: Record<string, string[]> = {
  linux: [
    'hostname',
    'uname -s -r',
    'cat /etc/os-release 2>/dev/null | head -5',
    'uptime',
    'ip -brief addr 2>/dev/null || ip addr 2>/dev/null | head -20',
  ],
  windows: [
    'hostname',
    '$PSVersionTable.PSVersion.ToString()',
    '[System.Environment]::OSVersion.VersionString',
    '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime',
    '(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB',
  ],
  network: [
    'show version | include Version',
    'show inventory | include NAME|DESCR|PID',
    'show ip interface brief',
    'show clock',
  ],
}

function classifyTarget(tab: TerminalTab, defaultClass?: string): string {
  // Raw-shell cisco/legacy presets expose no remoteOs; the algorithmsPreset
  // lives on the config, but the tab only carries `type`. We fall back to the
  // caller's hint, else assume linux for plain ssh tabs.
  if (tab.remoteOs === 'windows') return 'windows'
  if (tab.remoteOs === 'unix') return 'linux'
  return defaultClass ?? 'linux'
}

export async function collectFacts(
  args: CollectFactsArgs,
  context: ToolExecutionContext,
): Promise<string> {
  const { sessionId, messageId, sendEvent, terminalService } = context

  // Build the target list: explicit, or all open tabs.
  let targetTabs: TerminalTab[]
  if (args.targets && args.targets.length > 0) {
    const seen = new Set<string>()
    targetTabs = []
    for (const raw of args.targets) {
      const r = resolveTerminalForTool(context, raw)
      if (r.ok && !seen.has(r.terminal.id)) {
        seen.add(r.terminal.id)
        targetTabs.push(r.terminal)
      }
    }
  } else {
    targetTabs = terminalService.getAllTerminals?.() ?? []
  }

  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_started',
    toolName: 'collect_facts',
    title: `Inventory ${targetTabs.length} target(s)`,
    input: JSON.stringify(args),
  })
  const finish = (output: string): string => {
    sendEvent(sessionId, { messageId, type: 'sub_tool_delta', outputDelta: output })
    sendEvent(sessionId, { messageId, type: 'sub_tool_finished' })
    return output
  }

  if (targetTabs.length === 0) {
    return finish(
      'No open terminal tabs to inventory. Open tabs first with open_terminal_tab, or pass explicit target names.',
    )
  }

  // Collect facts per target in parallel. Each target runs its own small
  // command batch sequentially (its class template), but targets run
  // concurrently. Guardrail: every template command is policy-checked.
  const perTarget = await Promise.allSettled(
    targetTabs.map(async (tab): Promise<Record<string, unknown>> => {
      const klass = classifyTarget(tab, args.defaultClass)
      const commands = FACT_TEMPLATES[klass] ?? FACT_TEMPLATES.linux
      const facts: Record<string, string> = {}
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i]
        const policy = await checkCommandPolicy(cmd, 'collect_facts', context)
        if (!policy.allowed) {
          facts[`cmd${i}`] = `BLOCKED: ${policy.message}`
          continue
        }
        try {
          const res: CommandResult = await terminalService.runCommandAndWait(
            tab.id,
            cmd,
            { signal: context.signal, interruptOnAbort: false },
          )
          facts[`cmd${i}`] = truncateForFleet(res.stdoutDelta || '', 800)
        } catch (e) {
          if (isAbortError(e)) throw e
          facts[`cmd${i}`] = `ERROR: ${e instanceof Error ? e.message : String(e)}`
        }
      }
      return {
        target: tab.title || tab.id,
        class: klass,
        commands: Object.fromEntries(
          commands.map((c, i) => [`cmd${i}`, c] as const),
        ),
        facts,
      }
    }),
  )

  const records = perTarget.map((r, idx) => {
    const target = targetTabs[idx]?.title || targetTabs[idx]?.id || `target${idx}`
    if (r.status === 'fulfilled') return r.value
    const err = r.reason instanceof Error ? r.reason.message : String(r.reason)
    return { target, error: err }
  })

  return finish(
    `Collected facts from ${records.length} target(s).\n<inventory>\n${JSON.stringify(
      records,
      null,
      2,
    )}\n</inventory>`,
  )
}

// --- probe_connectivity ---

export const probeConnectivitySchema = z.object({
  connectionNameOrId: z
    .string()
    .min(1)
    .describe('Name or ID of a SAVED SSH connection to probe (opens a fresh tab).'),
  defaultClass: z
    .enum(['network', 'linux', 'windows'])
    .optional()
    .describe('OS hint used to classify the probed host (network/linux/windows).'),
})

export type ProbeConnectivityArgs = z.infer<typeof probeConnectivitySchema>

export async function probeConnectivity(
  args: ProbeConnectivityArgs,
  context: ToolExecutionContext,
): Promise<string> {
  const { connectionNameOrId, defaultClass } = args
  const { sessionId, messageId, sendEvent, terminalService } = context

  abortIfNeeded(context.signal)

  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_started',
    toolName: 'probe_connectivity',
    title: `Probe ${connectionNameOrId}`,
    input: JSON.stringify(args),
  })
  const finish = (output: string): string => {
    sendEvent(sessionId, { messageId, type: 'sub_tool_delta', outputDelta: output })
    sendEvent(sessionId, { messageId, type: 'sub_tool_finished' })
    return output
  }

  const entry = resolveSavedSshConnection(context, connectionNameOrId)
  if (!entry) {
    return finish(
      `No saved SSH connection found for "${connectionNameOrId}". Use manage_ssh_connection action="list" to see saved connections.`,
    )
  }

  // Reuse an already-open tab for this connection if present (don't stack tabs).
  const existing = terminalService.resolveTerminal(
    entry.name || `${entry.username}@${entry.host}`,
  )
  let tabId: string
  let reused = false
  let tab: TerminalTab | undefined
  if (existing.bestMatch) {
    tab = existing.bestMatch
    tabId = existing.bestMatch.id
    reused = true
  } else {
    try {
      const config = sshEntryToTerminalConfig(entry, {
        proxies: context.savedProxies ?? [],
        tunnels: context.savedTunnels ?? [],
        title: entry.name || `${entry.username}@${entry.host}`,
      })
      tab = await terminalService.createTerminal(config)
      tabId = tab.id
    } catch (error) {
      if (isAbortError(error)) throw error
      const message = error instanceof Error ? error.message : String(error)
      return finish(`Failed to open a tab for "${entry.name}": ${message}`)
    }
  }

  // Poll for readiness (ready/exited), up to a timeout. Raw-shell network tabs
  // become ready immediately; POSIX tabs wait for the integration marker.
  const deadline = Date.now() + PROBE_READY_TIMEOUT_MS
  let snapshot = terminalService.getTerminalRuntimeSnapshot(tabId)
  while (
    Date.now() < deadline &&
    snapshot &&
    snapshot.runtimeState !== 'ready' &&
    snapshot.runtimeState !== 'exited'
  ) {
    abortIfNeeded(context.signal)
    await waitWithSignal(PROBE_READY_POLL_MS, context.signal)
    snapshot = terminalService.getTerminalRuntimeSnapshot(tabId)
  }

  if (!snapshot) {
    return finish(`Tab for "${entry.name}" disappeared before becoming ready.`)
  }

  const klass = classifyTarget(tab as TerminalTab, defaultClass)
  const banner = terminalService.getRecentOutput?.(tabId) ?? ''
  const status = formatTerminalStatusHeader(snapshot)

  const verdict =
    snapshot.runtimeState === 'exited'
      ? 'UNREACHABLE (session exited)'
      : 'REACHABLE'

  return finish(
    `Probe of "${entry.name}" (${entry.username}@${entry.host}:${entry.port}): ${verdict}\n` +
      `class=${klass}, state=${snapshot.runtimeState}${reused ? ', tab=reused' : ', tab=opened'}\n` +
      `${status}\n` +
      `Initial banner:\n<terminal_content>\n${truncateForFleet(banner, 1500)}\n</terminal_content>`,
  )
}
