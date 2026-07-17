import {
  executeScheduledTask,
  resolveScheduledTaskCommand,
  resolveScheduledTaskTargets,
  type ScheduledTaskTerminalService,
} from './scheduledTaskRunner'
import type {
  BackendSettings,
  ScheduledTaskEntry,
  TerminalConfig,
} from '../../types'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) {
  cases.push({ name: n, run: r })
}

const baseSettings = (): BackendSettings =>
  ({
    connections: {
      ssh: [
        {
          id: 'ssh-1',
          name: 'core-rtr-01',
          host: '10.0.0.1',
          port: 22,
          username: 'admin',
          authMethod: 'password',
          password: 'x',
          groupId: 'grp-core',
        },
        {
          id: 'ssh-2',
          name: 'core-rtr-02',
          host: '10.0.0.2',
          port: 22,
          username: 'admin',
          authMethod: 'password',
          password: 'x',
          groupId: 'grp-core',
        },
        {
          id: 'ssh-3',
          name: 'web-1',
          host: '10.0.1.1',
          port: 22,
          username: 'ubuntu',
          authMethod: 'password',
          password: 'x',
        },
      ],
      winrm: [
        {
          id: 'win-1',
          name: 'win-dc-01',
          host: '10.0.2.1',
          port: 5985,
          username: 'admin',
          password: 'x',
          groupId: 'grp-win',
        },
      ],
      serial: [],
      proxies: [],
      tunnels: [],
    },
  }) as unknown as BackendSettings

const fakeAutomationManager = (scripts: Array<{ id: string; name: string; command: string }>) =>
  ({
    listScripts: () => scripts,
  }) as never

interface FakeTerminal {
  id: string
  runtimeState?: string
  config: TerminalConfig
  output: string
  exitCode: number
}

const fakeTerminalService = () => {
  const terminals: FakeTerminal[] = []
  const killed: string[] = []
  const service: ScheduledTaskTerminalService = {
    createTerminal: async (config: TerminalConfig) => {
      const t: FakeTerminal = {
        id: config.id,
        runtimeState: 'ready',
        config,
        output: 'ok\n',
        exitCode: 0,
      }
      terminals.push(t)
      return { id: t.id }
    },
    runCommandAndWait: async (terminalId: string, _command: string) => {
      const t = terminals.find((x) => x.id === terminalId)!
      return { stdoutDelta: t.output, exitCode: t.exitCode }
    },
    kill: (terminalId: string) => {
      killed.push(terminalId)
    },
    getAllTerminals: () => terminals,
  }
  return { service, terminals, killed }
}

const task = (over: Partial<ScheduledTaskEntry>): ScheduledTaskEntry => ({
  id: 'sch-1',
  name: 'nightly backup',
  cron: '0 2 * * *',
  enabled: true,
  ...over,
})

test('resolveScheduledTaskCommand prefers the inline command', () => {
  const cmd = resolveScheduledTaskCommand(
    task({ command: 'show run', scriptId: 'scr-1' }),
    fakeAutomationManager([{ id: 'scr-1', name: 's', command: 'script cmd' }]),
  )
  if (cmd !== 'show run') throw new Error(`got ${cmd}`)
})

test('resolveScheduledTaskCommand falls back to the saved script', () => {
  const cmd = resolveScheduledTaskCommand(
    task({ scriptId: 'scr-1' }),
    fakeAutomationManager([{ id: 'scr-1', name: 'backup', command: 'show run' }]),
  )
  if (cmd !== 'show run') throw new Error(`got ${cmd}`)
})

test('resolveScheduledTaskCommand throws for a missing script reference', () => {
  let threw = false
  try {
    resolveScheduledTaskCommand(task({ scriptId: 'scr-missing' }), fakeAutomationManager([]))
  } catch {
    threw = true
  }
  if (!threw) throw new Error('expected throw for missing script')
})

test('resolveScheduledTaskCommand throws when neither command nor scriptId is set', () => {
  let threw = false
  try {
    resolveScheduledTaskCommand(task({}), fakeAutomationManager([]))
  } catch {
    threw = true
  }
  if (!threw) throw new Error('expected throw for empty task')
})

test('resolveScheduledTaskTargets matches explicit names case-insensitively', () => {
  const targets = resolveScheduledTaskTargets(
    task({ targets: ['CORE-RTR-01', 'win-dc-01'] }),
    baseSettings(),
  )
  if (targets.length !== 2) throw new Error(`expected 2, got ${targets.length}`)
  if (targets[0].kind !== 'ssh' || targets[1].kind !== 'winrm') {
    throw new Error('kinds wrong')
  }
})

test('resolveScheduledTaskTargets matches a group across connection types', () => {
  const core = resolveScheduledTaskTargets(task({ groupId: 'grp-core' }), baseSettings())
  if (core.length !== 2) throw new Error(`expected 2 core targets, got ${core.length}`)
  const win = resolveScheduledTaskTargets(task({ groupId: 'grp-win' }), baseSettings())
  if (win.length !== 1 || win[0].kind !== 'winrm') throw new Error('winrm group wrong')
})

test('resolveScheduledTaskTargets returns empty for an empty scope (local run)', () => {
  const targets = resolveScheduledTaskTargets(task({}), baseSettings())
  if (targets.length !== 0) throw new Error(`expected 0, got ${targets.length}`)
})

test('executeScheduledTask runs locally when no scope is configured', async () => {
  const { service, terminals, killed } = fakeTerminalService()
  const outcomes = await executeScheduledTask(
    {
      terminalService: service,
      automationManager: fakeAutomationManager([]),
      getSettings: baseSettings,
    },
    task({ command: 'uptime' }),
  )
  if (outcomes.length !== 1) throw new Error(`expected 1 outcome, got ${outcomes.length}`)
  if (outcomes[0].target !== 'local' || !outcomes[0].ok) {
    throw new Error(JSON.stringify(outcomes[0]))
  }
  if (terminals[0].config.type !== 'local') throw new Error('should open a local terminal')
  if (killed.length !== 1) throw new Error('terminal should be torn down after the run')
})

test('executeScheduledTask fans out to group targets and passes credentials through', async () => {
  const { service, terminals, killed } = fakeTerminalService()
  const outcomes = await executeScheduledTask(
    {
      terminalService: service,
      automationManager: fakeAutomationManager([]),
      getSettings: baseSettings,
    },
    task({ command: 'show run', groupId: 'grp-core' }),
  )
  if (outcomes.length !== 2) throw new Error(`expected 2 outcomes, got ${outcomes.length}`)
  if (!outcomes.every((o) => o.ok)) throw new Error(JSON.stringify(outcomes))
  const cfg = terminals[0].config as never as Record<string, unknown>
  if (cfg.type !== 'ssh' || cfg.host !== '10.0.0.1' || cfg.username !== 'admin') {
    throw new Error(`ssh config wrong: ${JSON.stringify(cfg)}`)
  }
  if (killed.length !== 2) throw new Error('both terminals should be torn down')
})

test('executeScheduledTask reports a non-zero exit as a failed outcome, not a throw', async () => {
  const { service, terminals } = fakeTerminalService()
  const outcomesPromise = executeScheduledTask(
    {
      terminalService: service,
      automationManager: fakeAutomationManager([]),
      getSettings: baseSettings,
    },
    task({ command: 'false' }),
  )
  terminals[0].exitCode = 2
  const outcomes = await outcomesPromise
  if (outcomes[0].ok !== false || outcomes[0].exitCode !== 2) {
    throw new Error(JSON.stringify(outcomes[0]))
  }
})

test('executeScheduledTask reports session-exited-before-ready as a failure', async () => {
  const { service, terminals } = fakeTerminalService()
  const promise = executeScheduledTask(
    {
      terminalService: {
        ...service,
        createTerminal: async (config: TerminalConfig) => {
          const t = { id: config.id, runtimeState: 'exited' }
          terminals.push(t as never)
          return { id: t.id }
        },
      },
      automationManager: fakeAutomationManager([]),
      getSettings: baseSettings,
      readyPollMs: 1,
      readyTimeoutMs: 50,
    },
    task({ command: 'uptime' }),
  )
  const outcomes = await promise
  if (outcomes[0].ok !== false || !String(outcomes[0].error).includes('exited')) {
    throw new Error(JSON.stringify(outcomes[0]))
  }
})

test('executeScheduledTask resolves the command from a saved script', async () => {
  const { service } = fakeTerminalService()
  let ran = ''
  const outcomes = await executeScheduledTask(
    {
      terminalService: {
        ...service,
        runCommandAndWait: async (_id: string, command: string) => {
          ran = command
          return { stdoutDelta: 'ok', exitCode: 0 }
        },
      },
      automationManager: fakeAutomationManager([
        { id: 'scr-1', name: 'backup', command: 'show running-config' },
      ]),
      getSettings: baseSettings,
    },
    task({ scriptId: 'scr-1' }),
  )
  if (ran !== 'show running-config') throw new Error(`ran "${ran}"`)
  if (!outcomes[0].ok) throw new Error(JSON.stringify(outcomes[0]))
})

async function main() {
  let pass = 0,
    fail = 0
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
