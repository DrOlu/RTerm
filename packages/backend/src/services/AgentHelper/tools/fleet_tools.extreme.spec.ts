import type { CommandResult, SSHConnectionEntry, TerminalTab } from '../../../types'
import type { TerminalRuntimeSnapshot } from '../../TerminalService'
import type { ICommandPolicyRuntime } from '../../runtimeContracts'
import type { ToolExecutionContext } from '../types'
import {
  runFleetCommand,
  collectFacts,
  probeConnectivity,
} from './fleet_tools'

/**
 * fleet_tools.extreme.spec — exercises run_fleet_command (parallel fan-out +
 * aggregation + policy gate), collect_facts (per-OS templates), and
 * probe_connectivity (open/reuse + readiness + classify) against a fake
 * terminal service that mirrors the real TerminalService surface these tools
 * touch.
 */

class AllowPolicy implements ICommandPolicyRuntime {
  decision: 'allow' | 'deny' = 'allow'
  setFeedbackWaiter(): void {}
  getPolicyFilePath(): string { return '/tmp/p.md' }
  async getLists() { return { allowlist: [], denylist: [], asklist: [] } }
  async addRule() { return { allowlist: [], denylist: [], asklist: [] } }
  async deleteRule() { return { allowlist: [], denylist: [], asklist: [] } }
  async evaluate(): Promise<'allow' | 'deny' | 'ask'> { return this.decision }
  async requestApproval(): Promise<boolean> { return true }
}

class FakeTerm {
  tabs: TerminalTab[] = []
  outputs: Record<string, string> = {}
  createdConfigs: any[] = []
  /** Map "tabId|command" -> override exitCode; default 0. */
  exitOverrides: Record<string, number> = {}
  /** Commands that should throw (simulating a not-ready / error). */
  failingCommands: Set<string> = new Set()

  addTab(id: string, title: string, opts: Partial<TerminalTab> = {}): TerminalTab {
    const tab: TerminalTab = {
      id,
      ptyId: `pty-${id}`,
      title,
      cols: 80,
      rows: 24,
      type: 'ssh',
      capabilities: { supportsFilesystem: true } as any,
      isInitializing: false,
      runtimeState: 'ready',
      ...opts,
    } as any
    this.tabs.push(tab)
    return tab
  }

  resolveTerminal(idOrName: string): { found: TerminalTab[]; bestMatch?: TerminalTab } {
    const m = this.tabs.find((t) => t.id === idOrName || t.title === idOrName)
    return m ? { found: [m], bestMatch: m } : { found: [] }
  }

  getTerminalRuntimeSnapshot(id: string): TerminalRuntimeSnapshot | null {
    const t = this.tabs.find((x) => x.id === id)
    if (!t) return null
    const state = (t.runtimeState ?? 'ready') as any
    return {
      id: t.id,
      title: t.title,
      type: t.type,
      runtimeState: state,
      isInitializing: state === 'initializing',
      lastExitCode: t.lastExitCode,
      reconnectable: false,
      canRunCommand: state === 'ready',
      canWrite: state === 'ready',
      canUseFilesystem: true,
    }
  }

  async runCommandAndWait(id: string, command: string): Promise<CommandResult> {
    if (this.failingCommands.has(`${id}|${command}`)) {
      throw new Error('There is a running exec_command in this terminal')
    }
    const out = this.outputs[`${id}|${command}`] ?? `out:${command}`
    const exit = this.exitOverrides[`${id}|${command}`] ?? 0
    return { stdoutDelta: out, exitCode: exit, history_command_match_id: `h-${id}-${command}` }
  }

  getAllTerminals(): TerminalTab[] { return this.tabs }
  getRecentOutput(id: string): string { return this.outputs[`banner:${id}`] ?? '' }

  async createTerminal(config: any): Promise<TerminalTab> {
    this.createdConfigs.push(config)
    const tab = this.addTab(`auto-${this.createdConfigs.length}`, config.title, { runtimeState: 'ready' })
    return tab
  }
}

function ctx(
  term: FakeTerm,
  opts: { policy?: AllowPolicy; savedSsh?: SSHConnectionEntry[] } = {},
): ToolExecutionContext {
  return {
    sessionId: 's',
    messageId: 'm',
    terminalService: term as any,
    sendEvent: () => {},
    commandPolicyService: (opts.policy ?? new AllowPolicy()) as any,
    commandPolicyMode: 'standard',
    savedSshConnections: opts.savedSsh ?? [],
  } as any
}

const cases: Array<{ name: string; run: () => Promise<void> }> = []
function test(name: string, run: () => Promise<void>) { cases.push({ name, run }) }

test('run_fleet_command aggregates ok + failures + resolve errors', async () => {
  const term = new FakeTerm()
  term.addTab('w1', 'web-1')
  term.addTab('w2', 'web-2')
  term.outputs['w1|uptime'] = ' 14:00 up 1 day'
  term.outputs['w2|uptime'] = ' 14:00 up 2 days'
  term.exitOverrides['w2|uptime'] = 0
  const res = await runFleetCommand(
    { targets: ['web-1', 'web-2', 'missing-tab'], command: 'uptime' },
    ctx(term),
  )
  if (!res.includes('2 ok')) throw new Error(`expected 2 ok, got: ${res}`)
  if (!res.includes('web-1') || !res.includes('web-2')) throw new Error('missing targets in results')
  if (!res.includes('FAIL') && !res.includes('missing-tab')) throw new Error('missing-tab should be reported')
  if (!res.includes('exit=0')) throw new Error('expected exit codes in structured block')
  if (!res.includes('<fleet_results')) throw new Error('expected structured block')
})

test('run_fleet_command dedupes duplicate targets', async () => {
  const term = new FakeTerm()
  term.addTab('w1', 'web-1')
  const res = await runFleetCommand({ targets: ['web-1', 'web-1', 'web-1'], command: 'hostname' }, ctx(term))
  if (!res.includes('1 target(s)')) throw new Error(`expected 1 unique target, got: ${res}`)
})

test('run_fleet_command skips not-ready tabs', async () => {
  const term = new FakeTerm()
  term.addTab('w1', 'web-1')
  term.addTab('init1', 'init-tab', { runtimeState: 'initializing' })
  const res = await runFleetCommand({ targets: ['web-1', 'init-tab'], command: 'ls' }, ctx(term))
  if (!res.includes('not ready for commands')) throw new Error(`expected not-ready message, got: ${res}`)
  if (!res.includes('web-1') && !res.includes('ls')) throw new Error('ready target should still run')
})

test('run_fleet_command blocked by policy blocks all targets', async () => {
  const term = new FakeTerm()
  term.addTab('w1', 'web-1')
  term.addTab('w2', 'web-2')
  const policy = new AllowPolicy()
  policy.decision = 'deny'
  const res = await runFleetCommand({ targets: ['web-1', 'web-2'], command: 'rm -rf /' }, ctx(term, { policy }))
  if (!res.includes('blocked by policy')) throw new Error(`expected blocked, got: ${res}`)
  // runCommandAndWait should never have been called -> no outputs recorded
})

test('collect_facts returns structured inventory across OS classes', async () => {
  const term = new FakeTerm()
  term.addTab('lnx', 'srv-linux', { remoteOs: 'unix' })
  term.addTab('win', 'srv-windows', { remoteOs: 'windows' })
  term.outputs['lnx|hostname'] = 'srv-linux'
  term.outputs['win|hostname'] = 'srv-windows'
  const res = await collectFacts({ targets: ['srv-linux', 'srv-windows'] }, ctx(term))
  if (!res.includes('<inventory>')) throw new Error('expected inventory block')
  if (!res.includes('"class": "linux"')) throw new Error('expected linux class')
  if (!res.includes('"class": "windows"')) throw new Error('expected windows class')
  if (!res.includes('srv-linux')) throw new Error('expected hostname fact')
})

test('collect_facts uses defaultClass hint for raw-shell network tabs', async () => {
  const term = new FakeTerm()
  term.addTab('c1', 'core-sw') // no remoteOs (raw-shell cisco)
  term.outputs['c1|show version | include Version'] = 'Cisco IOS-XE 17.6'
  const res = await collectFacts({ targets: ['core-sw'], defaultClass: 'network' }, ctx(term))
  if (!res.includes('"class": "network"')) throw new Error(`expected network class, got: ${res}`)
})

test('collect_facts with no targets inventories all open tabs', async () => {
  const term = new FakeTerm()
  term.addTab('a', 'host-a', { remoteOs: 'unix' })
  term.addTab('b', 'host-b', { remoteOs: 'unix' })
  const res = await collectFacts({}, ctx(term))
  if (!res.includes('host-a') || !res.includes('host-b')) throw new Error(`expected both hosts, got: ${res}`)
})

test('collect_facts with no open tabs reports empty', async () => {
  const res = await collectFacts({}, ctx(new FakeTerm()))
  if (!res.includes('No open terminal tabs')) throw new Error(`expected empty message, got: ${res}`)
})

test('probe_connectivity reports REACHABLE for a ready saved connection', async () => {
  const term = new FakeTerm()
  const saved: SSHConnectionEntry[] = [
    { id: 's1', name: 'core', host: '10.0.0.1', port: 22, username: 'admin', authMethod: 'password', algorithmsPreset: 'cisco', termType: 'vt100' },
  ]
  const res = await probeConnectivity({ connectionNameOrId: 'core', defaultClass: 'network' }, ctx(term, { savedSsh: saved }))
  if (!res.includes('REACHABLE')) throw new Error(`expected REACHABLE, got: ${res}`)
  if (!res.includes('class=network')) throw new Error('expected network class')
  if (!res.includes('tab=opened')) throw new Error('expected a fresh tab opened')
  if (term.createdConfigs.length !== 1) throw new Error('should have created exactly one tab')
})

test('probe_connectivity reuses an already-open tab', async () => {
  const term = new FakeTerm()
  term.addTab('t-core', 'core', { remoteOs: 'unix' })
  term.outputs['banner:t-core'] = 'Welcome to core'
  const saved: SSHConnectionEntry[] = [
    { id: 's1', name: 'core', host: '10.0.0.1', port: 22, username: 'admin', authMethod: 'password' },
  ]
  const res = await probeConnectivity({ connectionNameOrId: 'core' }, ctx(term, { savedSsh: saved }))
  if (!res.includes('tab=reused')) throw new Error(`expected reused, got: ${res}`)
  if (term.createdConfigs.length !== 0) throw new Error('should not create a new tab when one exists')
})

test('probe_connectivity reports UNREACHABLE when session exits', async () => {
  const term = new FakeTerm()
  const saved: SSHConnectionEntry[] = [
    { id: 's2', name: 'down', host: '10.0.0.2', port: 22, username: 'admin', authMethod: 'password' },
  ]
  // Override createTerminal to produce an exited tab immediately.
  term.createTerminal = async (config: any) => {
    term.createdConfigs.push(config)
    const t = term.addTab(`auto-${term.createdConfigs.length}`, config.title, { runtimeState: 'exited', lastExitCode: 255 })
    return t
  }
  const res = await probeConnectivity({ connectionNameOrId: 'down', defaultClass: 'linux' }, ctx(term, { savedSsh: saved }))
  if (!res.includes('UNREACHABLE')) throw new Error(`expected UNREACHABLE, got: ${res}`)
})

test('probe_connectivity reports missing saved connection helpfully', async () => {
  const res = await probeConnectivity({ connectionNameOrId: 'nope' }, ctx(new FakeTerm()))
  if (!res.includes('No saved SSH connection found')) throw new Error(`expected missing message, got: ${res}`)
})

async function main() {
  let pass = 0
  let fail = 0
  for (const c of cases) {
    try {
      await c.run()
      pass++
      console.log(`PASS ${c.name}`)
    } catch (e: any) {
      fail++
      console.log(`FAIL ${c.name}: ${e?.message ?? e}`)
    }
  }
  console.log(`\n${pass}/${cases.length} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main()
