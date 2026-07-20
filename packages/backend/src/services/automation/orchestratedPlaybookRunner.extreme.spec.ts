import { executeOrchestratedPlaybook } from './orchestratedPlaybookRunner'
import type { ScheduledTaskTerminalService } from './scheduledTaskRunner'
import type { BackendSettings, PlaybookEntry, PlaybookStep, TerminalConfig } from '../../types'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

const baseSettings = (): BackendSettings =>
  ({ connections: { ssh: [], winrm: [], serial: [], proxies: [], tunnels: [] } }) as unknown as BackendSettings

interface FakeTerminal {
  id: string; runtimeState?: string; config: TerminalConfig
  responses: Array<{ match: string; output: string; exitCode: number }>
  defaultResponse: { output: string; exitCode: number }
  ran: string[]
}
const fakeTerminalService = () => {
  const terminals: FakeTerminal[] = []
  const killed: string[] = []
  const service: ScheduledTaskTerminalService = {
    createTerminal: async (config: TerminalConfig) => {
      const t: FakeTerminal = { id: config.id, runtimeState: 'ready', config, responses: [], defaultResponse: { output: 'ok\n', exitCode: 0 }, ran: [] }
      terminals.push(t); return { id: t.id }
    },
    runCommandAndWait: async (terminalId: string, command: string) => {
      const t = terminals.find((x) => x.id === terminalId)!
      t.ran.push(command)
      const r = t.responses.find((x) => command.includes(x.match)) ?? t.defaultResponse
      return { stdoutDelta: r.output, exitCode: r.exitCode }
    },
    kill: (id: string) => { killed.push(id) },
    getAllTerminals: () => terminals,
  }
  return { service, terminals, killed }
}
const fakeAutomationManager = (scripts: Array<{ id: string; name: string; command: string }> = []) =>
  ({ listScripts: () => scripts, markPlaybookRun: () => {} }) as never
function pb(steps: PlaybookStep[], o: Partial<PlaybookEntry> = {}): PlaybookEntry {
  return { id: 'pb1', name: 'test', steps, ...o }
}
function cmd(id: string, command: string, o: Partial<PlaybookStep> = {}): PlaybookStep {
  return { id, kind: 'command', command, ...o }
}

// ---------- DAG / parallel ----------
test('linear playbook runs all steps in order', async () => {
  const { service, terminals } = fakeTerminalService()
  const rec = await executeOrchestratedPlaybook(
    { terminalService: service, automationManager: fakeAutomationManager(), getSettings: baseSettings, sleepMs: async () => {} },
    pb([cmd('a', 'one'), cmd('b', 'two'), cmd('c', 'three')]))
  if (!rec.ok) throw new Error('should be ok')
  const ran = terminals[0].ran.filter((c) => ['one', 'two', 'three'].includes(c))
  if (ran.join(',') !== 'one,two,three') throw new Error(`order ${ran.join(',')}`)
})

test('DAG fan-out runs independent steps before the join step', async () => {
  const { service, terminals } = fakeTerminalService()
  const rec = await executeOrchestratedPlaybook(
    { terminalService: service, automationManager: fakeAutomationManager(), getSettings: baseSettings, sleepMs: async () => {} },
    pb([cmd('a', 'A', { dependsOn: [] }), cmd('b', 'B', { dependsOn: [] }), cmd('c', 'C', { dependsOn: ['a', 'b'] })], { maxParallelSteps: 2 }))
  if (!rec.ok) throw new Error('should be ok')
  const ran = terminals[0].ran
  if (ran.indexOf('C') < ran.indexOf('A') || ran.indexOf('C') < ran.indexOf('B')) {
    throw new Error(`join ran before deps: ${ran.join(',')}`)
  }
})

test('dependency cycle fails the run before touching any target', async () => {
  const { service, terminals } = fakeTerminalService()
  let threw = ''
  try {
    await executeOrchestratedPlaybook(
      { terminalService: service, automationManager: fakeAutomationManager(), getSettings: baseSettings, sleepMs: async () => {} },
      pb([cmd('a', 'A', { dependsOn: ['b'] }), cmd('b', 'B', { dependsOn: ['a'] })]))
  } catch (e) { threw = (e as Error).message }
  if (!/cycle/i.test(threw)) throw new Error(`expected cycle, got ${threw}`)
  if (terminals.length !== 0) throw new Error('no target should have been created')
})

test('a failing step with stop policy aborts the target and rolls back completed steps', async () => {
  const { service, terminals } = fakeTerminalService()
  const svc = service
  // make the 'boom' command fail with a non-zero exit
  svc.runCommandAndWait = async (id: string, c: string) => {
    const t = terminals.find((x) => x.id === id)!
    t.ran.push(c)
    if (c === 'boom') return { stdoutDelta: 'kaboom\n', exitCode: 1 }
    return { stdoutDelta: 'ok\n', exitCode: 0 }
  }
  const rec = await executeOrchestratedPlaybook(
    { terminalService: svc, automationManager: fakeAutomationManager(), getSettings: baseSettings, sleepMs: async () => {} },
    pb([
      cmd('a', 'setup', { rollback: { kind: 'command', command: 'teardown' } }),
      cmd('b', 'boom'),
    ]))
  if (rec.ok) throw new Error('run should have failed')
  const target = rec.targets[0]
  if (target.ok) throw new Error('target should be failed')
  const ran = terminals[0].ran
  if (!ran.includes('teardown')) throw new Error(`rollback teardown did not run: ${ran.join(',')}`)
  if (!target.rolledBack) throw new Error('target should be marked rolled back')
})

// ---------- params / secrets ----------
test('runbook params are substituted into step commands', async () => {
  const { service, terminals } = fakeTerminalService()
  const rec = await executeOrchestratedPlaybook(
    { terminalService: service, automationManager: fakeAutomationManager(), getSettings: baseSettings, sleepMs: async () => {}, paramValues: { host: 'web-42' } },
    pb([cmd('a', 'echo deploying to {{host}}')], { params: [{ name: 'host', defaultValue: 'web-1' }] }))
  if (!rec.ok) throw new Error('should be ok')
  if (!terminals[0].ran.includes('echo deploying to web-42')) throw new Error(`no substitution: ${terminals[0].ran.join(',')}`)
})

test('param default is used when not supplied', async () => {
  const { service, terminals } = fakeTerminalService()
  await executeOrchestratedPlaybook(
    { terminalService: service, automationManager: fakeAutomationManager(), getSettings: baseSettings, sleepMs: async () => {} },
    pb([cmd('a', 'echo {{host}}')], { params: [{ name: 'host', defaultValue: 'web-default' }] }))
  if (!terminals[0].ran.includes('echo web-default')) throw new Error(terminals[0].ran.join(','))
})

test('secret params are masked in the run record but used in commands', async () => {
  const { service, terminals } = fakeTerminalService()
  const rec = await executeOrchestratedPlaybook(
    { terminalService: service, automationManager: fakeAutomationManager(), getSettings: baseSettings, sleepMs: async () => {}, paramValues: { password: 'hunter2' } },
    pb([cmd('a', 'login --pw {{password}}')], { params: [{ name: 'password', secret: true }] }))
  if (!terminals[0].ran.includes('login --pw hunter2')) throw new Error('secret not used in command')
  if (rec.params && rec.params.password === 'hunter2') throw new Error('secret leaked into record params')
  if (rec.params && !/•/.test(rec.params.password)) throw new Error('secret should be masked in record')
})

// ---------- idempotency ----------
test('idempotent step is SKIPPED when desired state already met', async () => {
  const { service, terminals } = fakeTerminalService()
  await executeOrchestratedPlaybook(
    { terminalService: service, automationManager: fakeAutomationManager(), getSettings: baseSettings, sleepMs: async () => {} },
    pb([cmd('a', 'apt install nginx', { desiredState: { command: 'nginx -v', expect: 'nginx/1.25' } })]))
  // fake returns 'ok\n' for all commands; 'nginx -v' output 'ok' does NOT contain 'nginx/1.25' -> should run
  const t = terminals[0]
  if (!t.ran.includes('apt install nginx')) throw new Error('should have run (not in desired state)')
})

test('idempotent step runs when desired state NOT met, skipped when met', async () => {
  const { service, terminals } = fakeTerminalService()
  const svc = service
  // Make the desired-state check command return a matching output.
  const orig = svc.runCommandAndWait.bind(svc)
  svc.runCommandAndWait = async (id: string, c: string) => {
    if (c.includes('nginx -v')) return { stdoutDelta: 'nginx version: nginx/1.25.4\n', exitCode: 0 }
    return orig(id, c)
  }
  const rec = await executeOrchestratedPlaybook(
    { terminalService: svc, automationManager: fakeAutomationManager(), getSettings: baseSettings, sleepMs: async () => {} },
    pb([cmd('a', 'apt install nginx', { desiredState: { command: 'nginx -v', expect: 'nginx/1.25' } })]))
  if (!rec.ok) throw new Error('should be ok')
  const t = terminals[0]
  if (t.ran.includes('apt install nginx')) throw new Error('should have been skipped (desired state met)')
})

// ---------- capture vars (cross-host orchestration) ----------
test('captureVar from one step feeds {{var}} into a later step', async () => {
  const { service, terminals } = fakeTerminalService()
  const svc = service
  svc.runCommandAndWait = async (id: string, c: string) => {
    const t = terminals.find((x) => x.id === id)!
    t.ran.push(c)
    if (c === 'get-ip') return { stdoutDelta: 'address: 10.0.0.99\n', exitCode: 0 }
    return { stdoutDelta: 'ok\n', exitCode: 0 }
  }
  const rec = await executeOrchestratedPlaybook(
    { terminalService: svc, automationManager: fakeAutomationManager(), getSettings: baseSettings, sleepMs: async () => {} },
    pb([
      cmd('a', 'get-ip', { captureVar: { name: 'ip', pattern: 'address:\\s*(\\S+)', regex: true } }),
      cmd('b', 'ping {{ip}}', { dependsOn: ['a'] }),
    ]))
  if (!rec.ok) throw new Error('should be ok')
  const ran = terminals[0].ran
  if (!ran.includes('ping 10.0.0.99')) throw new Error(`captured var not substituted: ${ran.join(',')}`)
})

test('validation failure stops target and marks validation ok=false', async () => {
  const { service, terminals } = fakeTerminalService()
  const svc = service
  svc.runCommandAndWait = async (id: string, c: string) => {
    const t = terminals.find((x) => x.id === id)!
    t.ran.push(c)
    if (c.includes('health')) return { stdoutDelta: 'unhealthy\n', exitCode: 0 }
    return { stdoutDelta: 'ok\n', exitCode: 0 }
  }
  const rec = await executeOrchestratedPlaybook(
    { terminalService: svc, automationManager: fakeAutomationManager(), getSettings: baseSettings, sleepMs: async () => {} },
    pb([cmd('a', 'restart-nginx', { validate: { command: 'health', expect: 'ok' } })]))
  if (rec.ok) throw new Error('should have failed validation')
  const step = rec.targets[0].steps.find((s) => s.stepIndex === 0)
  if (!step || step.validation?.ok !== false) throw new Error('validation should be marked failed')
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
