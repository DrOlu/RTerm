import {
  executePlaybook,
  resolvePlaybookStepCommand,
  listPlaybookRuns,
  getPlaybookRun,
  clearPlaybookRuns,
  type PlaybookRunnerDeps,
} from './playbookRunner'
import type { ScheduledTaskTerminalService } from './scheduledTaskRunner'
import type { BackendSettings, PlaybookEntry, PlaybookStep, TerminalConfig } from '../../types'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) {
  cases.push({ name: n, run: r })
}

const baseSettings = (): BackendSettings =>
  ({
    connections: {
      ssh: [
        {
          id: 'ssh-1', name: 'core-rtr-01', host: '10.0.0.1', port: 22,
          username: 'admin', authMethod: 'password', password: 'x', groupId: 'grp-core',
        },
        {
          id: 'ssh-2', name: 'core-rtr-02', host: '10.0.0.2', port: 22,
          username: 'admin', authMethod: 'password', password: 'x', groupId: 'grp-core',
        },
      ],
      winrm: [],
      serial: [],
      proxies: [],
      tunnels: [],
    },
  }) as unknown as BackendSettings

interface FakeTerminal {
  id: string
  runtimeState?: string
  config: TerminalConfig
  /** Per-command responses keyed by command substring; falls back to default. */
  responses: Array<{ match: string; output: string; exitCode: number }>
  defaultResponse: { output: string; exitCode: number }
  ran: string[]
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
        responses: [],
        defaultResponse: { output: 'ok\n', exitCode: 0 },
        ran: [],
      }
      terminals.push(t)
      return { id: t.id }
    },
    runCommandAndWait: async (terminalId: string, command: string) => {
      const t = terminals.find((x) => x.id === terminalId)!
      t.ran.push(command)
      const r = t.responses.find((x) => command.includes(x.match)) ?? t.defaultResponse
      return { stdoutDelta: r.output, exitCode: r.exitCode }
    },
    kill: (terminalId: string) => { killed.push(terminalId) },
    getAllTerminals: () => terminals,
  }
  return { service, terminals, killed }
}

const fakeAutomationManager = (scripts: Array<{ id: string; name: string; command: string }>) =>
  ({
    listScripts: () => scripts,
    markPlaybookRun: () => {},
  }) as never

const step = (over: Partial<PlaybookStep>): PlaybookStep => ({ id: `st-${Math.random()}`, kind: 'command', ...over })

const playbook = (over: Partial<PlaybookEntry>): PlaybookEntry => ({
  id: 'pb-1',
  name: 'upgrade playbook',
  steps: [step({ command: 'show version' })],
  ...over,
})

const deps = (over: Partial<PlaybookRunnerDeps>): PlaybookRunnerDeps => ({
  terminalService: fakeTerminalService().service,
  automationManager: fakeAutomationManager([]),
  getSettings: baseSettings,
  sleepMs: async () => {},
  ...over,
})

test('resolvePlaybookStepCommand returns the inline command', () => {
  const cmd = resolvePlaybookStepCommand(step({ command: 'show run' }), fakeAutomationManager([]))
  if (cmd !== 'show run') throw new Error(`got ${cmd}`)
})

test('resolvePlaybookStepCommand resolves a saved script', () => {
  const cmd = resolvePlaybookStepCommand(
    step({ kind: 'script', scriptId: 'scr-1' }),
    fakeAutomationManager([{ id: 'scr-1', name: 'backup', command: 'show run' }]),
  )
  if (cmd !== 'show run') throw new Error(`got ${cmd}`)
})

test('resolvePlaybookStepCommand throws for a missing script', () => {
  let threw = false
  try {
    resolvePlaybookStepCommand(step({ kind: 'script', scriptId: 'nope' }), fakeAutomationManager([]))
  } catch { threw = true }
  if (!threw) throw new Error('expected throw')
})

test('resolvePlaybookStepCommand returns null for wait steps', () => {
  const cmd = resolvePlaybookStepCommand(step({ kind: 'wait', waitSeconds: 5 }), fakeAutomationManager([]))
  if (cmd !== null) throw new Error(`expected null, got ${cmd}`)
})

test('runs all steps sequentially on the local shell when no scope is set', async () => {
  const { service, terminals, killed } = fakeTerminalService()
  const pb = playbook({
    steps: [
      step({ command: 'term length 0', name: 'prep' }),
      step({ command: 'show run | incl hostname', name: 'collect' }),
      step({ kind: 'wait', waitSeconds: 1, name: 'settle' }),
      step({ command: 'write memory', name: 'save' }),
    ],
  })
  const rec = await executePlaybook(deps({ terminalService: service }), pb)
  if (!rec.ok) throw new Error(`run failed: ${JSON.stringify(rec)}`)
  if (rec.targets.length !== 1 || rec.targets[0].target !== 'local') throw new Error('expected local target')
  if (rec.targets[0].steps.length !== 4) throw new Error(`expected 4 step outcomes, got ${rec.targets[0].steps.length}`)
  const ran = terminals[0].ran
  if (ran.length !== 3) throw new Error(`wait step should not run a command; ran=${JSON.stringify(ran)}`)
  if (ran[0] !== 'term length 0' || ran[1] !== 'show run | incl hostname' || ran[2] !== 'write memory') {
    throw new Error(`wrong order: ${JSON.stringify(ran)}`)
  }
  if (killed.length !== 1) throw new Error('terminal not cleaned up')
})

test('runs against every target in the group scope', async () => {
  const { service, terminals } = fakeTerminalService()
  const pb = playbook({ groupId: 'grp-core', steps: [step({ command: 'show version' })] })
  const rec = await executePlaybook(deps({ terminalService: service }), pb)
  if (!rec.ok) throw new Error('run failed')
  if (rec.targets.length !== 2) throw new Error(`expected 2 targets, got ${rec.targets.length}`)
  const names = rec.targets.map((t) => t.target).sort()
  if (names.join(',') !== 'core-rtr-01,core-rtr-02') throw new Error(names.join(','))
  if (terminals.length !== 2) throw new Error('expected 2 terminals')
})

test('a failing step stops remaining steps for that target (default policy)', async () => {
  const pb = playbook({
    steps: [
      step({ command: 'reload', name: 'boom' }),
      step({ command: 'show version', name: 'never runs' }),
    ],
  })
  const { service: svc2, terminals: terms2 } = fakeTerminalService()
  // Wrap createTerminal to seed a failing response for 'reload'.
  const baseCreate = svc2.createTerminal.bind(svc2)
  svc2.createTerminal = async (config: TerminalConfig) => {
    const out = await baseCreate(config)
    const t = terms2.find((x) => x.id === out.id)!
    t.responses.push({ match: 'reload', output: 'not allowed\n', exitCode: 1 })
    return out
  }
  const rec = await executePlaybook(deps({ terminalService: svc2 }), pb)
  if (rec.ok) throw new Error('expected failure')
  const steps = rec.targets[0].steps
  if (steps.length !== 1) throw new Error(`expected 1 step (stopped), got ${steps.length}`)
  if (steps[0].ok) throw new Error('step should have failed')
  if (terms2[0].ran.length !== 1) throw new Error('second step must not run')
})

test('onError continue at playbook level proceeds past failures', async () => {
  const { service: svc, terminals: terms } = fakeTerminalService()
  const baseCreate = svc.createTerminal.bind(svc)
  svc.createTerminal = async (config: TerminalConfig) => {
    const out = await baseCreate(config)
    const t = terms.find((x) => x.id === out.id)!
    t.responses.push({ match: 'risky', output: 'err\n', exitCode: 2 })
    return out
  }
  const pb = playbook({
    onError: 'continue',
    steps: [
      step({ command: 'risky op', name: 'may fail' }),
      step({ command: 'show version', name: 'still runs' }),
    ],
  })
  const rec = await executePlaybook(deps({ terminalService: svc }), pb)
  const steps = rec.targets[0].steps
  if (steps.length !== 2) throw new Error(`expected 2 steps, got ${steps.length}`)
  if (steps[0].ok) throw new Error('first step should fail')
  if (!steps[0].continuedAfterFailure) throw new Error('expected continuedAfterFailure flag')
  if (!steps[1].ok) throw new Error('second step should succeed')
  if (rec.targets[0].ok) throw new Error('target should be marked failed overall')
  if (rec.ok) throw new Error('run should be marked failed overall')
})

test('step-level onError overrides the playbook default', async () => {
  const { service: svc, terminals: terms } = fakeTerminalService()
  const baseCreate = svc.createTerminal.bind(svc)
  svc.createTerminal = async (config: TerminalConfig) => {
    const out = await baseCreate(config)
    const t = terms.find((x) => x.id === out.id)!
    t.responses.push({ match: 'flaky', output: 'err\n', exitCode: 1 })
    return out
  }
  const pb = playbook({
    // playbook default is stop; this step opts into continue
    steps: [
      step({ command: 'flaky check', onError: 'continue' }),
      step({ command: 'show version' }),
    ],
  })
  const rec = await executePlaybook(deps({ terminalService: svc }), pb)
  if (rec.targets[0].steps.length !== 2) throw new Error('step-level continue not honored')
})

test('a target that fails does not stop other targets', async () => {
  const { service: svc, terminals: terms } = fakeTerminalService()
  const baseCreate = svc.createTerminal.bind(svc)
  svc.createTerminal = async (config: TerminalConfig) => {
    const out = await baseCreate(config)
    const t = terms.find((x) => x.id === out.id)!
    // Fail only the first target's session command.
    if (terms.length === 1) t.defaultResponse = { output: 'err\n', exitCode: 9 }
    return out
  }
  const pb = playbook({ groupId: 'grp-core', steps: [step({ command: 'show version' })] })
  const rec = await executePlaybook(deps({ terminalService: svc }), pb)
  if (rec.targets.length !== 2) throw new Error('both targets should run')
  if (rec.targets[0].ok) throw new Error('first target should fail')
  if (!rec.targets[1].ok) throw new Error('second target should succeed')
  if (rec.ok) throw new Error('run should be failed overall')
})

test('run history records the run and caps at the history limit', async () => {
  clearPlaybookRuns()
  const { service } = fakeTerminalService()
  const pb = playbook({ steps: [step({ command: 'show version' })] })
  const d = deps({ terminalService: service, historyLimit: 3 })
  const rec1 = await executePlaybook(d, pb)
  if (listPlaybookRuns().length !== 1) throw new Error('history not appended')
  if (listPlaybookRuns()[0].runId !== rec1.runId) throw new Error('newest run should be first')
  if (!getPlaybookRun(rec1.runId)) throw new Error('getPlaybookRun lookup failed')
  // Push past the cap — oldest entries drop off.
  await executePlaybook(d, pb)
  await executePlaybook(d, pb)
  const rec4 = await executePlaybook(d, pb)
  const hist = listPlaybookRuns()
  if (hist.length !== 3) throw new Error(`cap violated: ${hist.length}`)
  if (hist[0].runId !== rec4.runId) throw new Error('newest not first after cap')
  if (hist.some((r) => r.runId === rec1.runId)) throw new Error('oldest run should have been evicted')
})

test('markPlaybookRun stamps last-run status on the entry', async () => {
  const marks: Array<{ id: string; ok: boolean }> = []
  const mgr = {
    listScripts: () => [],
    markPlaybookRun: (id: string, ok: boolean) => { marks.push({ id, ok }) },
  } as never
  const { service } = fakeTerminalService()
  const pb = playbook({ id: 'pb-42', steps: [step({ command: 'show version' })] })
  await executePlaybook(deps({ terminalService: service, automationManager: mgr }), pb)
  if (marks.length !== 1 || marks[0].id !== 'pb-42' || marks[0].ok !== true) {
    throw new Error(`marks=${JSON.stringify(marks)}`)
  }
})

test('script steps resolve through the automation manager', async () => {
  const { service, terminals } = fakeTerminalService()
  const mgr = fakeAutomationManager([{ id: 'scr-9', name: 'golden', command: 'show gold' }])
  const pb = playbook({ steps: [step({ kind: 'script', scriptId: 'scr-9', name: 'golden config' })] })
  const rec = await executePlaybook(deps({ terminalService: service, automationManager: mgr }), pb)
  if (!rec.ok) throw new Error('run failed')
  if (terminals[0].ran[0] !== 'show gold') throw new Error(`ran=${terminals[0].ran[0]}`)
})

test('wait steps actually wait using the injected clock', async () => {
  const waits: number[] = []
  const { service } = fakeTerminalService()
  const pb = playbook({ steps: [step({ kind: 'wait', waitSeconds: 7 })] })
  await executePlaybook(deps({ terminalService: service, sleepMs: async (ms) => { waits.push(ms) } }), pb)
  if (!waits.includes(7000)) throw new Error(`waits=${JSON.stringify(waits)}`)
})

async function main() {
  let pass = 0, fail = 0
  for (const c of cases) {
    try { await c.run(); pass++; console.log(`PASS ${c.name}`) }
    catch (e: any) { fail++; console.log(`FAIL ${c.name}: ${e?.message ?? e}`) }
  }
  console.log(`\n${pass}/${cases.length} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
void main()
