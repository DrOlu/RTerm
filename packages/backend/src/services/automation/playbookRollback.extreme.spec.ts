import {
  executePlaybook,
  matchExpectation,
  clearPlaybookRuns,
  type PlaybookRunnerDeps,
} from './playbookRunner'
import type { ScheduledTaskTerminalService } from './scheduledTaskRunner'
import type { BackendSettings, PlaybookEntry, PlaybookStep, TerminalConfig } from '../../types'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(`ASSERT: ${msg}`) }

const baseSettings = (): BackendSettings =>
  ({
    connections: {
      ssh: [
        { id: 'ssh-1', name: 'rtr-01', host: '10.0.0.1', port: 22, username: 'a', authMethod: 'password', password: 'x', groupId: 'g1' },
        { id: 'ssh-2', name: 'rtr-02', host: '10.0.0.2', port: 22, username: 'a', authMethod: 'password', password: 'x', groupId: 'g1' },
      ],
      winrm: [], serial: [], proxies: [], tunnels: [],
    },
  }) as unknown as BackendSettings

interface FakeTerm {
  id: string; runtimeState?: string; config: TerminalConfig
  responses: Array<{ match: string; output: string; exitCode: number }>
  defaultResponse: { output: string; exitCode: number }
  ran: string[]
}

const fakeTerminalService = () => {
  const terminals: FakeTerm[] = []
  const service: ScheduledTaskTerminalService = {
    createTerminal: async (config: TerminalConfig) => {
      const t: FakeTerm = { id: config.id, runtimeState: 'ready', config, responses: [], defaultResponse: { output: 'ok\n', exitCode: 0 }, ran: [] }
      terminals.push(t)
      return { id: t.id }
    },
    runCommandAndWait: async (terminalId: string, command: string) => {
      const t = terminals.find((x) => x.id === terminalId)!
      t.ran.push(command)
      const r = t.responses.find((x) => command.includes(x.match)) ?? t.defaultResponse
      return { stdoutDelta: r.output, exitCode: r.exitCode }
    },
    kill: () => {},
    getAllTerminals: () => terminals,
  }
  return { service, terminals }
}

const fakeAutomationManager = (scripts: Array<{ id: string; name: string; command: string }> = []) =>
  ({ listScripts: () => scripts, markPlaybookRun: () => {} }) as never

let seq = 0
const step = (over: Partial<PlaybookStep>): PlaybookStep =>
  ({ id: `st-${++seq}`, kind: 'command', command: `cmd-${seq}`, ...over }) as PlaybookStep

const rb = (cmd: string) => ({ kind: 'command' as const, command: cmd })

const pb = (steps: PlaybookStep[], over: Partial<PlaybookEntry> = {}): PlaybookEntry =>
  ({ id: 'pb-t', name: 'test-mop', steps, ...over })


/** Make `boom` commands fail on the default fake service. */
const boomFails = (service: ScheduledTaskTerminalService, terminals: FakeTerm[]): void => {
  service.runCommandAndWait = async (terminalId: string, command: string) => {
    const t = terminals.find((x) => x.id === terminalId)!
    t.ran.push(command)
    if (command.includes('boom')) return { stdoutDelta: 'err', exitCode: 1 }
    return { stdoutDelta: 'ok', exitCode: 0 }
  }
}

const deps = (service: ScheduledTaskTerminalService, extra: Partial<PlaybookRunnerDeps> = {}): PlaybookRunnerDeps => ({
  terminalService: service,
  automationManager: fakeAutomationManager(),
  getSettings: baseSettings,
  sleepMs: async () => {},
  readyPollMs: 1,
  ...extra,
})

test('matchExpectation: substring, regex, invalid-regex fallback', () => {
  assert(matchExpectation('BGP neighbor is Established', 'Established') === true, 'substring hit')
  assert(matchExpectation('BGP neighbor is Idle', 'Established') === false, 'substring miss')
  assert(matchExpectation(' Gi0/1 is up, line protocol is up', 'Gi0/1 is up', 'regex') === true, 'regex hit')
  assert(matchExpectation('rate 3000 pps', '^rate [45]000', 'regex') === false, 'regex anchored miss')
  assert(matchExpectation('literal [broken output', '[broken', 'regex') === true, 'invalid regex falls back to substring')
})

test('step failure unwinds completed steps in reverse order', async () => {
  const { service, terminals } = fakeTerminalService()
  const steps = [
    step({ name: 'one', command: 'change-1', rollback: rb('undo-1') }),
    step({ name: 'two', command: 'change-2', rollback: rb('undo-2') }),
    step({ name: 'three', command: 'boom', rollback: rb('undo-3') }),
  ]
  boomFails(service, terminals)
  const record = await executePlaybook(deps(service), pb(steps))
  const t = record.targets[0]
  assert(!t.ok, 'target failed')
  assert(t.rolledBack === true, 'rolledBack flag set')
  assert(t.rollbackOk === true, 'rollbackOk true')
  const ran = terminals[0].ran
  const order = ran.slice(ran.indexOf('boom') + 1)
  assert(JSON.stringify(order) === JSON.stringify(['undo-3', 'undo-2', 'undo-1']), `reverse order incl. failed step first, got ${JSON.stringify(order)}`)
  assert(t.steps.every((s) => s.rolledBack === true), 'all steps marked rolledBack')
})

test('steps without rollback are skipped in the unwind', async () => {
  const { service, terminals } = fakeTerminalService()
  const steps = [
    step({ command: 'change-1' }), // no rollback
    step({ command: 'change-2', rollback: rb('undo-2') }),
    step({ command: 'boom' }),     // no rollback either
  ]
  boomFails(service, terminals)
  await executePlaybook(deps(service), pb(steps))
  const ran = terminals[0].ran
  const order = ran.slice(ran.indexOf('boom') + 1)
  assert(JSON.stringify(order) === JSON.stringify(['undo-2']), `only defined rollbacks run, got ${JSON.stringify(order)}`)
})

test('validation mismatch fails the step and triggers rollback', async () => {
  const { service, terminals } = fakeTerminalService()
  terminals.length // created lazily; set responses after run starts via match on check cmd
  const steps = [
    step({ command: 'apply-acl', rollback: rb('remove-acl'), validate: { command: 'show bgp', expect: 'Established' } }),
    step({ command: 'never-reached' }),
  ]
  // Default response lacks "Established" → validation fails.
  const record = await executePlaybook(deps(service), pb(steps))
  const t = record.targets[0]
  assert(!t.ok, 'target failed')
  assert(t.steps[0].validation?.ok === false, 'validation recorded as failed')
  assert((t.steps[0].error ?? '').includes('validation failed'), 'error mentions validation')
  const ran = terminals[0].ran
  assert(ran.includes('remove-acl'), 'rollback executed')
  assert(!ran.includes('never-reached'), 'subsequent steps never ran')
  assert(ran.indexOf('remove-acl') > ran.indexOf('show bgp'), 'rollback after validation check')
})

test('validation pass (regex mode) lets the playbook continue', async () => {
  const { service } = fakeTerminalService()
  const steps = [
    step({ command: 'apply', validate: { command: 'check', expect: '^state: (ok|stable)$', expectMode: 'regex' } }),
    step({ command: 'next' }),
  ]
  const record = await executePlaybook(deps(service), pb(steps))
  // default output "ok\n" does NOT match ^state:... → need a terminal with matching output
  // default is 'ok\n' so validation fails; adjust: expect 'ok' substring instead via second run
  assert(!record.ok, 'regex mismatch fails as expected')
  const steps2 = [
    step({ command: 'apply', validate: { command: 'check', expect: '^ok', expectMode: 'regex' } }),
    step({ command: 'next' }),
  ]
  const record2 = await executePlaybook(deps(service), pb(steps2))
  assert(record2.ok, 'regex match passes and playbook completes')
  assert(record2.targets[0].steps[0].validation?.ok === true, 'validation recorded ok')
})

test('onError=continue does not roll back, but failed-continued steps join the undo stack', async () => {
  const { service, terminals } = fakeTerminalService()
  const steps = [
    step({ command: 'change-1', rollback: rb('undo-1') }),
    step({ command: 'flaky', rollback: rb('undo-flaky'), onError: 'continue' }),
    step({ command: 'final-boom' }), // stop policy, no rollback of its own
  ]
  service.runCommandAndWait = async (terminalId: string, command: string) => {
    const t = terminals.find((x) => x.id === terminalId)!
    t.ran.push(command)
    if (command.includes('flaky') && !command.includes('undo')) return { stdoutDelta: 'err', exitCode: 1 }
    if (command.includes('final-boom')) return { stdoutDelta: 'err', exitCode: 1 }
    return { stdoutDelta: 'ok', exitCode: 0 }
  }
  const record = await executePlaybook(deps(service), pb(steps))
  const t = record.targets[0]
  assert(t.steps[1].continuedAfterFailure === true, 'flaky step continued after failure')
  const ran = terminals[0].ran
  const order = ran.slice(ran.indexOf('final-boom') + 1)
  assert(JSON.stringify(order) === JSON.stringify(['undo-flaky', 'undo-1']), `continued step rolled back too, got ${JSON.stringify(order)}`)
})

test('rollback command failure is recorded (rollbackOk=false)', async () => {
  const { service, terminals } = fakeTerminalService()
  const steps = [
    step({ command: 'change-1', rollback: rb('undo-1') }),
    step({ command: 'boom' }),
  ]
  service.runCommandAndWait = async (terminalId: string, command: string) => {
    const t = terminals.find((x) => x.id === terminalId)!
    t.ran.push(command)
    if (command.includes('boom')) return { stdoutDelta: 'err', exitCode: 1 }
    if (command.includes('undo-1')) return { stdoutDelta: 'cannot undo', exitCode: 2 }
    return { stdoutDelta: 'ok', exitCode: 0 }
  }
  const record = await executePlaybook(deps(service), pb(steps))
  const t = record.targets[0]
  assert(t.rolledBack === true && t.rollbackOk === false, 'rollback failure flagged')
  assert((t.steps[0].rollbackError ?? '').includes('exit code 2'), 'rollback error captured')
})

test('per-target scope: failed target rolls back, other targets still complete', async () => {
  const { service, terminals } = fakeTerminalService()
  const steps = [
    step({ command: 'change-1', rollback: rb('undo-1') }),
    step({ command: 'maybe-boom' }),
  ]
  service.runCommandAndWait = async (terminalId: string, command: string) => {
    const t = terminals.find((x) => x.id === terminalId)!
    t.ran.push(command)
    const isFirstTarget = t.config.title?.includes('rtr-01') || t.config.id.includes('rtr-01')
    if (command.includes('maybe-boom') && isFirstTarget) return { stdoutDelta: 'err', exitCode: 1 }
    return { stdoutDelta: 'ok', exitCode: 0 }
  }
  const record = await executePlaybook(deps(service), pb(steps, { groupId: 'g1' }))
  assert(record.targets.length === 2, 'two targets resolved')
  const [t1, t2] = record.targets
  assert(!t1.ok && t1.rolledBack === true, 'target 1 rolled back')
  assert(t2.ok && t2.rolledBack === undefined, 'target 2 completed untouched')
  assert(record.ok === false, 'run overall failed')
})

test('validation via saved script id resolves and runs', async () => {
  const { service, terminals } = fakeTerminalService()
  const scripts = [{ id: 'sc-check', name: 'bgp-check', command: 'show ip bgp summary' }]
  const steps = [
    step({ command: 'apply', rollback: rb('undo'), validate: { scriptId: 'sc-check', expect: 'ok' } }),
  ]
  const d: PlaybookRunnerDeps = {
    terminalService: service,
    automationManager: fakeAutomationManager(scripts),
    getSettings: baseSettings,
    sleepMs: async () => {},
    readyPollMs: 1,
  }
  const record = await executePlaybook(d, pb(steps))
  assert(record.ok, 'script-based validation passed')
  assert(terminals[0].ran.includes('show ip bgp summary'), 'validation script command ran')
})

test('change ledger receives execute/validate/rollback events', async () => {
  const { service } = fakeTerminalService()
  const rows: Array<{ phase: string; ok: boolean; stepIndex: number }> = []
  const fakeLedger = {
    recordStep: (r: { phase: string; ok: boolean; stepIndex: number }) => { rows.push(r) },
  }
  const steps = [
    step({ command: 'change-1', rollback: rb('undo-1'), validate: { command: 'check-1', expect: 'ok' } }),
    step({ command: 'boom', rollback: rb('undo-2') }),
  ]
  service.runCommandAndWait = (async (terminalId: string, command: string) => {
    const t = (service as never as { getAllTerminals: () => FakeTerm[] }).getAllTerminals().find((x) => x.id === terminalId)!
    t.ran.push(command)
    if (command.includes('boom')) return { stdoutDelta: 'err', exitCode: 1 }
    return { stdoutDelta: 'ok', exitCode: 0 }
  }) as never
  const record = await executePlaybook(deps(service, { changeLedger: fakeLedger, changeId: 'chg-test' }), pb(steps))
  assert(!record.ok, 'run failed')
  const phases = rows.map((r) => `${r.phase}:${r.stepIndex}:${r.ok ? 'ok' : 'fail'}`)
  assert(phases.includes('execute:0:ok'), 'execute ok recorded')
  assert(phases.includes('validate:0:ok'), 'validate ok recorded')
  assert(phases.includes('execute:1:fail'), 'execute fail recorded')
  assert(phases.includes('rollback:1:ok') && phases.includes('rollback:0:ok'), 'both rollbacks recorded')
  assert(phases.indexOf('rollback:1:ok') < phases.indexOf('rollback:0:ok'), 'failed step rollback recorded before unwind')
})

test('wait steps and no-rollback steps produce no undo work; local scope still rolls back', async () => {
  const { service, terminals } = fakeTerminalService()
  const steps = [
    step({ command: 'change-1', rollback: rb('undo-1') }),
    step({ kind: 'wait', waitSeconds: 5, command: undefined }),
    step({ command: 'boom' }),
  ]
  boomFails(service, terminals)
  const record = await executePlaybook(deps(service), pb(steps)) // no scope → local
  assert(record.targets[0].target === 'local', 'local target')
  const ran = terminals[0].ran
  assert(ran[ran.length - 1] === 'undo-1', 'undo ran last on local target')
  assert(record.targets[0].rolledBack === true, 'local rolled back')
})

// --- runner ---
;(async () => {
  clearPlaybookRuns()
  let pass = 0
  const failed: string[] = []
  for (const c of cases) {
    try {
      await c.run()
      pass++
      console.log(`PASS ${c.name}`)
    } catch (e) {
      failed.push(c.name)
      console.log(`FAIL ${c.name}: ${e instanceof Error ? e.message : e}`)
    }
  }
  console.log(`\n${pass}/${cases.length} passed`)
  if (failed.length) process.exit(1)
})()
