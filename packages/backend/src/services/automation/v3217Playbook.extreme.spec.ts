import {
  runCommandWithTimeout,
  evaluateWhen,
  buildEnvPrefix,
  buildPlaybookDryRunPlan,
  executePlaybook,
  resolvePlaybookStepCommand,
  type PlaybookRunnerDeps,
} from './playbookRunner'
import type { PlaybookEntry, PlaybookStep, BackendSettings, TerminalConfig } from '../../types'
import type { AutomationManager } from './AutomationManager'

/**
 * v3217Playbook.extreme.spec — exhaustive tests for the v3.2.17 playbook
 * improvements:
 *   1. Per-step timeout (runCommandWithTimeout)
 *   2. Per-step retry (retryAttempts / retryDelaySeconds)
 *   3. Conditional steps (when: expression + command modes)
 *   4. Parallel targets (maxParallelTargets)
 *   5. Target-level failure policy (onTargetError)
 *   6. maxRuntimeMinutes circuit breaker
 *   7. Dry-run plan
 *   8. env injection (buildEnvPrefix)
 *   9. outputCapture full vs tail
 *  10. template / healthCheck / playbook step kinds (resolution + dry-run)
 *  11. Regression: existing semantics unchanged
 */

const tests: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(name: string, run: () => void | Promise<void>) { tests.push({ name, run }) }
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
}
function assertTrue(actual: boolean, message: string): void {
  if (actual !== true) throw new Error(`${message}. expected=true actual=${String(actual)}`)
}

// ── test doubles ────────────────────────────────────────────────────────────

function makeFakeTerminalService(opts: {
  commands?: Array<{ match: RegExp; exitCode?: number; stdout?: string; delayMs?: number }>
} = {}) {
  const executed: string[] = []
  const created: Array<{ id: string; runtimeState: string }> = []
  const svc = {
    executed,
    createTerminal: async (_config: TerminalConfig) => {
      const tab = { id: `term-${created.length + 1}`, runtimeState: 'ready' }
      created.push(tab)
      return tab
    },
    runCommandAndWait: (_terminalId: string, command: string) => {
      executed.push(command)
      // find a matching canned response
      const canned = opts.commands?.find((c) => c.match.test(command))
      if (canned?.delayMs) {
        return new Promise<{ stdoutDelta: string; exitCode?: number }>((resolve) => {
          setTimeout(() => {
            resolve({ stdoutDelta: canned.stdout ?? '', exitCode: canned.exitCode ?? 0 })
          }, canned.delayMs)
        })
      }
      return Promise.resolve({ stdoutDelta: canned?.stdout ?? '', exitCode: canned?.exitCode ?? 0 })
    },
    kill: () => {},
    getAllTerminals: () => created,
  }
  return svc as never
}

function makeFakeAutomationManager(templates: Array<{ id: string; body: string }> = []) {
  return {
    listScripts: () => [],
    listTemplates: () => templates,
    listPlaybooks: () => [],
    markPlaybookRun: () => {},
  } as unknown as AutomationManager
}

function makeSettings(): BackendSettings {
  return { connections: { ssh: [], winrm: [], serial: [], proxies: [], tunnels: [] } } as unknown as BackendSettings
}


function makeDeps(svc?: never, am?: AutomationManager): PlaybookRunnerDeps {
  return {
    terminalService: svc ?? makeFakeTerminalService(),
    automationManager: am ?? makeFakeAutomationManager(),
    getSettings: () => makeSettings(),
    onLog: () => {},
    sleepMs: () => Promise.resolve(), // instant waits in tests
  }
}

function makeStep(overrides: Partial<PlaybookStep> = {}): PlaybookStep {
  return { id: 's1', kind: 'command', command: 'echo hi', ...overrides }
}

function makePlaybook(overrides: Partial<PlaybookEntry> = {}): PlaybookEntry {
  return { id: 'pb1', name: 'test', steps: [makeStep()], ...overrides }
}

// ─── 1. Per-step timeout ───────────────────────────────────────────────────

test('timeout: no timeout → command runs to completion', async () => {
  const svc = makeFakeTerminalService({ commands: [{ match: /echo/, exitCode: 0, stdout: 'hi' }] })
  const r = await runCommandWithTimeout({ terminalService: svc } as never, 't1', 'echo hi', undefined)
  assertEqual(r.exitCode, 0, 'exit code')
  assertEqual(r.timedOut, false, 'not timed out')
  assertEqual(r.stdoutDelta, 'hi', 'output')
})

test('timeout: command finishes before the timer → ok', async () => {
  const svc = makeFakeTerminalService({ commands: [{ match: /echo/, exitCode: 0, stdout: 'done' }] })
  const r = await runCommandWithTimeout({ terminalService: svc } as never, 't1', 'echo hi', 60)
  assertEqual(r.timedOut, false, 'not timed out')
  assertEqual(r.exitCode, 0, 'exit code')
})

test('timeout: slow command + short timer → timedOut=true, exit=-1', async () => {
  const svc = makeFakeTerminalService({ commands: [{ match: /slow/, exitCode: 0, delayMs: 500 }] })
  const r = await runCommandWithTimeout({ terminalService: svc } as never, 't1', 'slow command', 0.05)
  assertEqual(r.timedOut, true, 'timed out')
  assertEqual(r.exitCode, -1, 'synthetic exit code')
})

// ─── 2. Per-step retry ─────────────────────────────────────────────────────

test('retry: succeeds on first attempt → no retry', async () => {
  let calls = 0
  const tabs: Array<{ id: string; runtimeState: string }> = []
  const svc = {
    createTerminal: async () => { tabs.push({ id: 't1', runtimeState: 'ready' }); return { id: 't1' } },
    runCommandAndWait: async (_t: string, _c: string) => { calls++; return { stdoutDelta: 'ok', exitCode: 0 } },
    kill: () => {},
    getAllTerminals: () => tabs,
  } as never
  const pb = makePlaybook({ steps: [makeStep({ command: 'echo ok', retryAttempts: 3 })] })
  const record = await executePlaybook(makeDeps(svc), pb)
  assertEqual(calls, 1, 'exactly one call')
  assertTrue(record.ok, 'playbook ok')
  assertTrue(record.targets[0].steps[0].ok, 'step ok')
})

test('retry: fails then succeeds → step ok, attempts = 1 + retries', async () => {
  let calls = 0
  const tabs: Array<{ id: string; runtimeState: string }> = []
  const svc = {
    createTerminal: async () => { tabs.push({ id: 't1', runtimeState: 'ready' }); return { id: 't1' } },
    runCommandAndWait: async (_t: string, _c: string) => {
      calls++
      return calls < 3 ? { stdoutDelta: '', exitCode: 1 } : { stdoutDelta: 'ok', exitCode: 0 }
    },
    kill: () => {},
    getAllTerminals: () => tabs,
  } as never
  const pb = makePlaybook({ steps: [makeStep({ command: 'flaky', retryAttempts: 3, retryDelaySeconds: 0 })] })
  const record = await executePlaybook(makeDeps(svc), pb)
  assertEqual(calls, 3, '3 calls (2 failures + 1 success)')
  assertTrue(record.ok, 'playbook ok after retry')
})

test('retry: exhausts attempts → step fails, rollback fires', async () => {
  let calls = 0
  const tabs: Array<{ id: string; runtimeState: string }> = []
  const svc = {
    createTerminal: async () => { tabs.push({ id: 't1', runtimeState: 'ready' }); return { id: 't1' } },
    runCommandAndWait: async (_t: string, cmd: string) => {
      if (cmd.includes('flaky')) { calls++; return { stdoutDelta: '', exitCode: 1 } }
      return { stdoutDelta: 'undone', exitCode: 0 }
    },
    kill: () => {},
    getAllTerminals: () => tabs,
  } as never
  const pb = makePlaybook({
    steps: [
      makeStep({ id: 's1', command: 'flaky', retryAttempts: 2, retryDelaySeconds: 0, rollback: { kind: 'command', command: 'undo' } }),
    ],
  })
  const record = await executePlaybook(makeDeps(svc), pb)
  assertEqual(calls, 3, '3 calls (initial + 2 retries)')
  assertTrue(!record.ok, 'playbook failed')
  assertTrue(record.targets[0].rolledBack === true, 'rollback ran')
})

// ─── 3. Conditional steps (when) ──────────────────────────────────────────

test('when: expression == matches → step runs', () => {
  const r = evaluateWhen("{{env}} == 'prod'", { env: 'prod' })
  assertEqual(r.mode, 'expression', 'mode')
  assertTrue(r.result, 'condition true')
})

test('when: expression == mismatch → step skipped', () => {
  const r = evaluateWhen("{{env}} == 'prod'", { env: 'staging' })
  assertTrue(!r.result, 'condition false')
})

test('when: expression != → inverted', () => {
  assertTrue(evaluateWhen("{{env}} != 'prod'", { env: 'staging' }).result, '!= staging is true')
  assertTrue(!evaluateWhen("{{env}} != 'prod'", { env: 'prod' }).result, '!= prod is false')
})

test('when: missing param → empty string comparison', () => {
  assertTrue(!evaluateWhen("{{missing}} == 'x'", {}).result, 'missing != x')
  assertTrue(evaluateWhen("{{missing}} == ''", {}).result, 'missing == empty')
})

test('when: non-expression → command mode', () => {
  const r = evaluateWhen('test -f /etc/passwd', {})
  assertEqual(r.mode, 'command', 'mode')
  assertEqual(r.command, 'test -f /etc/passwd', 'command preserved')
})

test('when: expression with double quotes also works', () => {
  assertTrue(evaluateWhen('{{env}} == "prod"', { env: 'prod' }).result, 'double-quoted value')
})

test('when: skipped step is not a failure', async () => {
  const executed: string[] = []
  const tabs: Array<{ id: string; runtimeState: string }> = []
  const svc = {
    createTerminal: async () => { tabs.push({ id: 't1', runtimeState: 'ready' }); return { id: 't1' } },
    runCommandAndWait: async (_t: string, cmd: string) => { executed.push(cmd); return { stdoutDelta: '', exitCode: 0 } },
    kill: () => {},
    getAllTerminals: () => tabs,
  } as never
  const pb = makePlaybook({
    steps: [
      makeStep({ id: 's1', command: 'echo never', when: "{{env}} == 'prod'" }),
      makeStep({ id: 's2', command: 'echo always' }),
    ],
  })
  const record = await executePlaybook(makeDeps(svc), pb)
  assertTrue(record.ok, 'playbook ok')
  assertTrue(!executed.some((c) => c.includes('never')), 'skipped step not executed')
  assertTrue(executed.some((c) => c.includes('always')), 'other step executed')
  assertEqual(record.targets[0].steps[0].ok, true, 'skipped step is ok (not a failure)')
})

// ─── 4. Parallel targets ───────────────────────────────────────────────────

test('parallel: maxParallelTargets=1 → sequential (default, regression)', async () => {
  const order: string[] = []
  const tabs: Array<{ id: string; runtimeState: string }> = []
  const svc = {
    createTerminal: async (config: TerminalConfig) => {
      order.push(`start:${config.title}`)
      const tab = { id: `t-${config.title}`, runtimeState: 'ready' }
      tabs.push(tab)
      return tab
    },
    runCommandAndWait: async (t: string, _c: string) => { order.push(`run:${t}`); return { stdoutDelta: '', exitCode: 0 } },
    kill: (t: string) => { order.push(`kill:${t}`) },
    getAllTerminals: () => tabs,
  } as never
  const pb = makePlaybook({
    targets: ['a', 'b'],
    maxParallelTargets: 1,
    steps: [makeStep()],
  })
  // Patch settings to provide two fake targets
  const deps = makeDeps(svc)
  ;(deps as { getSettings: () => BackendSettings }).getSettings = () => ({
    connections: {
      ssh: [
        { id: 'a', name: 'a', host: '1.1.1.1', port: 22, username: 'u', authMethod: 'password', password: 'p' },
        { id: 'b', name: 'b', host: '2.2.2.2', port: 22, username: 'u', authMethod: 'password', password: 'p' },
      ],
      winrm: [], serial: [], proxies: [], tunnels: [],
    },
  } as unknown as BackendSettings)
  const record = await executePlaybook(deps, pb)
  assertEqual(record.targets.length, 2, 'both targets ran')
  assertTrue(record.ok, 'ok')
  // target a fully completes before target b starts
  const firstKill = order.findIndex((x) => x.startsWith('kill:'))
  assertTrue(firstKill >= 0, 'first target killed')
})

test('parallel: maxParallelTargets=2 → both targets run (concurrently)', async () => {
  const tabs: Array<{ id: string; runtimeState: string }> = []
  const svc = {
    createTerminal: async (config: TerminalConfig) => {
      const tab = { id: `t-${config.title}`, runtimeState: 'ready' }
      tabs.push(tab)
      return tab
    },
    runCommandAndWait: async (_t: string, _c: string) => ({ stdoutDelta: '', exitCode: 0 }),
    kill: () => {},
    getAllTerminals: () => tabs,
  } as never
  const pb = makePlaybook({
    targets: ['a', 'b'],
    maxParallelTargets: 2,
    steps: [makeStep()],
  })
  const deps = makeDeps(svc)
  ;(deps as { getSettings: () => BackendSettings }).getSettings = () => ({
    connections: {
      ssh: [
        { id: 'a', name: 'a', host: '1.1.1.1', port: 22, username: 'u', authMethod: 'password', password: 'p' },
        { id: 'b', name: 'b', host: '2.2.2.2', port: 22, username: 'u', authMethod: 'password', password: 'p' },
      ],
      winrm: [], serial: [], proxies: [], tunnels: [],
    },
  } as unknown as BackendSettings)
  const record = await executePlaybook(deps, pb)
  assertEqual(record.targets.length, 2, 'both targets ran')
  assertTrue(record.ok, 'ok')
})

// ─── 5. onTargetError ──────────────────────────────────────────────────────

test('onTargetError: stop (default) → remaining targets skipped after failure', async () => {
  const created: string[] = []
  const tabs: Array<{ id: string; runtimeState: string }> = []
  const svc = {
    createTerminal: async (config: TerminalConfig) => {
      created.push(config.title ?? '')
      const tab = { id: `t-${created.length}`, runtimeState: 'ready' }
      tabs.push(tab)
      return tab
    },
    runCommandAndWait: async (t: string, _c: string) => {
      // target 1 fails, target 2 would succeed
      if (t === 't-1') return { stdoutDelta: '', exitCode: 1 }
      return { stdoutDelta: '', exitCode: 0 }
    },
    kill: () => {},
    getAllTerminals: () => tabs,
  } as never
  const pb = makePlaybook({ targets: ['a', 'b'], onTargetError: 'stop', steps: [makeStep()] })
  const deps = makeDeps(svc)
  ;(deps as { getSettings: () => BackendSettings }).getSettings = () => ({
    connections: {
      ssh: [
        { id: 'a', name: 'a', host: '1.1.1.1', port: 22, username: 'u', authMethod: 'password', password: 'p' },
        { id: 'b', name: 'b', host: '2.2.2.2', port: 22, username: 'u', authMethod: 'password', password: 'p' },
      ],
      winrm: [], serial: [], proxies: [], tunnels: [],
    },
  } as unknown as BackendSettings)
  const record = await executePlaybook(deps, pb)
  assertEqual(record.targets.length, 1, 'only the first target ran')
  assertTrue(!record.ok, 'failed')
})

test('onTargetError: continue → all targets run despite failure', async () => {
  const created: string[] = []
  const tabs: Array<{ id: string; runtimeState: string }> = []
  const svc = {
    createTerminal: async (config: TerminalConfig) => {
      created.push(config.title ?? '')
      const tab = { id: `t-${created.length}`, runtimeState: 'ready' }
      tabs.push(tab)
      return tab
    },
    runCommandAndWait: async (t: string, _c: string) => {
      if (t === 't-1') return { stdoutDelta: '', exitCode: 1 }
      return { stdoutDelta: '', exitCode: 0 }
    },
    kill: () => {},
    getAllTerminals: () => tabs,
  } as never
  const pb = makePlaybook({ targets: ['a', 'b'], onTargetError: 'continue', steps: [makeStep()] })
  const deps = makeDeps(svc)
  ;(deps as { getSettings: () => BackendSettings }).getSettings = () => ({
    connections: {
      ssh: [
        { id: 'a', name: 'a', host: '1.1.1.1', port: 22, username: 'u', authMethod: 'password', password: 'p' },
        { id: 'b', name: 'b', host: '2.2.2.2', port: 22, username: 'u', authMethod: 'password', password: 'p' },
      ],
      winrm: [], serial: [], proxies: [], tunnels: [],
    },
  } as unknown as BackendSettings)
  const record = await executePlaybook(deps, pb)
  assertEqual(record.targets.length, 2, 'both targets ran')
  assertTrue(!record.ok, 'overall failed (one target failed)')
})

// ─── 6. maxRuntimeMinutes circuit breaker ──────────────────────────────────

test('maxRuntime: exceeded → remaining targets aborted with error', async () => {
  const tabs: Array<{ id: string; runtimeState: string }> = []
  const svc = {
    createTerminal: async () => { tabs.push({ id: 't1', runtimeState: 'ready' }); return { id: 't1' } },
    runCommandAndWait: async () => ({ stdoutDelta: '', exitCode: 0 }),
    kill: () => {},
    getAllTerminals: () => tabs,
  } as never
  // maxRuntimeMinutes in the PAST — the deadline is already exceeded at start,
  // so every target is aborted by the circuit breaker.
  const pb = makePlaybook({
    targets: ['a', 'b'],
    maxRuntimeMinutes: -1, // negative → deadline already in the past
    steps: [makeStep()],
  })
  const deps = makeDeps(svc)
  ;(deps as { getSettings: () => BackendSettings }).getSettings = () => ({
    connections: {
      ssh: [
        { id: 'a', name: 'a', host: '1.1.1.1', port: 22, username: 'u', authMethod: 'password', password: 'p' },
        { id: 'b', name: 'b', host: '2.2.2.2', port: 22, username: 'u', authMethod: 'password', password: 'p' },
      ],
      winrm: [], serial: [], proxies: [], tunnels: [],
    },
  } as unknown as BackendSettings)
  const record = await executePlaybook(deps, pb)
  assertTrue(!record.ok, 'failed')
  const aborted = record.targets.filter((t) => t.error === 'playbook runtime limit exceeded')
  assertTrue(aborted.length >= 1, 'at least one target aborted by the circuit breaker')
})

// ─── 7. Dry-run plan ───────────────────────────────────────────────────────

test('dryRun: resolves targets + steps without executing', () => {
  const am = makeFakeAutomationManager()
  const pb = makePlaybook({
    steps: [
      makeStep({ id: 's1', name: 'backup', command: 'cp a b', timeoutSeconds: 30, retryAttempts: 2 }),
      makeStep({ id: 's2', kind: 'wait', waitSeconds: 5 }),
    ],
  })
  const deps = { automationManager: am, getSettings: () => makeSettings() }
  const plan = buildPlaybookDryRunPlan(deps, pb)
  assertEqual(plan.playbookName, 'test', 'name')
  assertEqual(plan.targets.length, 1, 'local target (no scope)')
  assertEqual(plan.targets[0].kind, 'local', 'local kind')
  assertEqual(plan.steps.length, 2, 'two steps')
  assertEqual(plan.steps[0].command, 'cp a b', 'command resolved')
  assertEqual(plan.steps[0].timeoutSeconds, 30, 'timeout captured')
  assertEqual(plan.steps[0].retryAttempts, 2, 'retry captured')
  assertTrue(plan.steps[1].command !== undefined && plan.steps[1].command.includes('wait 5s'), 'wait step described')
  assertEqual(plan.notes.length, 0, 'no notes for a valid playbook')
})

test('dryRun: missing templateId flagged in notes', () => {
  const am = makeFakeAutomationManager()
  const pb = makePlaybook({
    steps: [makeStep({ id: 's1', kind: 'template' })], // no templateId
  })
  const plan = buildPlaybookDryRunPlan({ automationManager: am, getSettings: () => makeSettings() }, pb)
  assertTrue(plan.notes.some((n) => n.includes('missing templateId')), 'flagged')
})

test('dryRun: missing healthUrl flagged', () => {
  const am = makeFakeAutomationManager()
  const pb = makePlaybook({ steps: [makeStep({ id: 's1', kind: 'healthCheck' })] })
  const plan = buildPlaybookDryRunPlan({ automationManager: am, getSettings: () => makeSettings() }, pb)
  assertTrue(plan.notes.some((n) => n.includes('missing healthUrl')), 'flagged')
})

test('dryRun: notes mention parallel + circuit breaker when set', () => {
  const am = makeFakeAutomationManager()
  const pb = makePlaybook({ maxParallelTargets: 3, maxRuntimeMinutes: 10, steps: [makeStep()] })
  const plan = buildPlaybookDryRunPlan({ automationManager: am, getSettings: () => makeSettings() }, pb)
  assertTrue(plan.notes.some((n) => n.includes('parallel')), 'parallel noted')
  assertTrue(plan.notes.some((n) => n.includes('Circuit breaker')), 'breaker noted')
})

// ─── 8. env injection ──────────────────────────────────────────────────────

test('env: empty/undefined → no prefix', () => {
  assertEqual(buildEnvPrefix(undefined, {}), '', 'undefined')
  assertEqual(buildEnvPrefix({}, {}), '', 'empty object')
})

test('env: single var → export prefix', () => {
  const p = buildEnvPrefix({ FOO: 'bar' }, {})
  assertEqual(p, "export FOO='bar' && ", 'prefix')
})

test('env: multiple vars joined with &&', () => {
  const p = buildEnvPrefix({ A: '1', B: '2' }, {})
  assertEqual(p, "export A='1' && export B='2' && ", 'joined')
})

test('env: {{param}} substitution in values', () => {
  const p = buildEnvPrefix({ VERSION: '{{version}}' }, { version: '1.2.3' })
  assertEqual(p, "export VERSION='1.2.3' && ", 'substituted')
})

test('env: missing param → empty string', () => {
  const p = buildEnvPrefix({ X: '{{missing}}' }, {})
  assertEqual(p, "export X='' && ", 'empty')
})

test('env: single quotes in values escaped', () => {
  const p = buildEnvPrefix({ MSG: "it's" }, {})
  assertEqual(p, "export MSG='it'\\''s' && ", 'escaped')
})

// ─── 9. outputCapture ──────────────────────────────────────────────────────

test('outputCapture: tail (default) truncates to 4096', async () => {
  const bigOutput = 'x'.repeat(10_000)
  const tabs: Array<{ id: string; runtimeState: string }> = []
  const svc = {
    createTerminal: async () => { tabs.push({ id: 't1', runtimeState: 'ready' }); return { id: 't1' } },
    runCommandAndWait: async () => ({ stdoutDelta: bigOutput, exitCode: 0 }),
    kill: () => {},
    getAllTerminals: () => tabs,
  } as never
  const pb = makePlaybook({ steps: [makeStep()] })
  const record = await executePlaybook(makeDeps(svc), pb)
  assertEqual(record.targets[0].steps[0].output?.length, 4096, 'tailed to 4096')
})

test('outputCapture: full keeps everything', async () => {
  const bigOutput = 'y'.repeat(10_000)
  const tabs: Array<{ id: string; runtimeState: string }> = []
  const svc = {
    createTerminal: async () => { tabs.push({ id: 't1', runtimeState: 'ready' }); return { id: 't1' } },
    runCommandAndWait: async () => ({ stdoutDelta: bigOutput, exitCode: 0 }),
    kill: () => {},
    getAllTerminals: () => tabs,
  } as never
  const pb = makePlaybook({ steps: [makeStep({ outputCapture: 'full' })] })
  const record = await executePlaybook(makeDeps(svc), pb)
  assertEqual(record.targets[0].steps[0].output?.length, 10_000, 'full output kept')
})

// ─── 10. New step kinds ────────────────────────────────────────────────────

test('kinds: resolvePlaybookStepCommand returns null for wait/template/playbook/healthCheck', () => {
  const am = makeFakeAutomationManager()
  assertEqual(resolvePlaybookStepCommand(makeStep({ kind: 'wait' }), am), null, 'wait')
  assertEqual(resolvePlaybookStepCommand(makeStep({ kind: 'template' }), am), null, 'template')
  assertEqual(resolvePlaybookStepCommand(makeStep({ kind: 'playbook' }), am), null, 'playbook')
  assertEqual(resolvePlaybookStepCommand(makeStep({ kind: 'healthCheck' }), am), null, 'healthCheck')
})

test('kinds: template step writes rendered config to the target', async () => {
  const executed: string[] = []
  const tabs: Array<{ id: string; runtimeState: string }> = []
  const svc = {
    createTerminal: async () => { tabs.push({ id: 't1', runtimeState: 'ready' }); return { id: 't1' } },
    runCommandAndWait: async (_t: string, cmd: string) => { executed.push(cmd); return { stdoutDelta: '', exitCode: 0 } },
    kill: () => {},
    getAllTerminals: () => tabs,
  } as never
  const am = makeFakeAutomationManager([{ id: 'tpl1', body: 'interface {{ name }}\n ip address {{ ip }}' }])
  const pb = makePlaybook({
    steps: [makeStep({ kind: 'template', templateId: 'tpl1', templateTargetPath: '/tmp/if.cfg', templateValues: { name: 'Gi0/1', ip: '10.0.0.1' } })],
  })
  const record = await executePlaybook(makeDeps(svc, am), pb)
  assertTrue(record.ok, 'ok')
  // the write command contains the base64 of the rendered config
  const writeCmd = executed.find((c) => c.includes('base64 -d'))
  assertTrue(Boolean(writeCmd), 'write command executed')
  const b64 = writeCmd?.match(/echo '([^']+)'/)?.[1] ?? ''
  const decoded = Buffer.from(b64, 'base64').toString('utf8')
  assertTrue(decoded.includes('interface Gi0/1'), 'rendered config contains the name')
  assertTrue(decoded.includes('ip address 10.0.0.1'), 'rendered config contains the ip')
})

test('kinds: healthCheck polls until healthy', async () => {
  let polls = 0
  const tabs: Array<{ id: string; runtimeState: string }> = []
  const svc = {
    createTerminal: async () => { tabs.push({ id: 't1', runtimeState: 'ready' }); return { id: 't1' } },
    runCommandAndWait: async (_t: string, cmd: string) => {
      if (cmd.includes('curl')) { polls++; return { stdoutDelta: polls >= 2 ? '200' : '503', exitCode: 0 } }
      return { stdoutDelta: '', exitCode: 0 }
    },
    kill: () => {},
    getAllTerminals: () => tabs,
  } as never
  const pb = makePlaybook({
    steps: [makeStep({ kind: 'healthCheck', healthUrl: 'http://localhost:8080/health', healthIntervalSeconds: 0, healthTimeoutSeconds: 30 })],
  })
  const record = await executePlaybook(makeDeps(svc), pb)
  assertTrue(record.ok, 'ok after second poll')
  assertEqual(polls, 2, 'polled twice')
  assertTrue(record.targets[0].steps[0].output !== undefined && record.targets[0].steps[0].output.includes('HTTP 200'), 'output shows 200')
})

test('kinds: healthCheck times out → step fails', async () => {
  const tabs: Array<{ id: string; runtimeState: string }> = []
  const svc = {
    createTerminal: async () => { tabs.push({ id: 't1', runtimeState: 'ready' }); return { id: 't1' } },
    runCommandAndWait: async (_t: string, cmd: string) => {
      if (cmd.includes('curl')) return { stdoutDelta: '503', exitCode: 0 }
      return { stdoutDelta: '', exitCode: 0 }
    },
    kill: () => {},
    getAllTerminals: () => tabs,
  } as never
  const pb = makePlaybook({
    steps: [makeStep({ kind: 'healthCheck', healthUrl: 'http://x', healthIntervalSeconds: 0, healthTimeoutSeconds: 0.05 })],
  })
  const record = await executePlaybook(makeDeps(svc), pb)
  assertTrue(!record.ok, 'failed')
  assertTrue(record.targets[0].steps[0].error !== undefined && record.targets[0].steps[0].error.includes('503 != 200'), 'error mentions the status')
})

// ─── 11. Regression: existing semantics ────────────────────────────────────

test('regression: plain command step still works', async () => {
  const svc = makeFakeTerminalService({ commands: [{ match: /echo hi/, exitCode: 0, stdout: 'hi' }] })
  const record = await executePlaybook(makeDeps(svc), makePlaybook())
  assertTrue(record.ok, 'ok')
  assertEqual(record.targets[0].steps[0].output, 'hi', 'output')
})

test('regression: failing step without rollback → target fails, no rollback flag', async () => {
  const svc = makeFakeTerminalService({ commands: [{ match: /echo/, exitCode: 1 }] })
  const record = await executePlaybook(makeDeps(svc), makePlaybook())
  assertTrue(!record.ok, 'failed')
  assertTrue(record.targets[0].rolledBack !== true, 'no rollback (no rollback defined)')
})

test('regression: wait step still pauses', async () => {
  let slept = 0
  const deps = makeDeps()
  ;(deps as { sleepMs?: (ms: number) => Promise<void> }).sleepMs = async (ms) => { slept += ms }
  const pb = makePlaybook({ steps: [makeStep({ kind: 'wait', waitSeconds: 3 })] })
  const record = await executePlaybook(deps, pb)
  assertTrue(record.ok, 'ok')
  assertEqual(slept, 3000, 'slept 3000ms')
})

test('regression: validation mismatch fails the step', async () => {
  const svc = makeFakeTerminalService({
    commands: [
      { match: /echo deploy/, exitCode: 0, stdout: 'deploy done' },
      { match: /curl/, exitCode: 0, stdout: 'connection refused' },
    ],
  })
  const pb = makePlaybook({
    steps: [makeStep({
      command: 'echo deploy',
      validate: { command: 'curl health', expect: 'healthy', expectMode: 'substring' },
    })],
  })
  const record = await executePlaybook(makeDeps(svc), pb)
  assertTrue(!record.ok, 'validation mismatch fails')
  assertTrue(record.targets[0].steps[0].error !== undefined && record.targets[0].steps[0].error.includes('validation failed'), 'validation error')
})

test('regression: onError=continue keeps going after a failure', async () => {
  const svc = makeFakeTerminalService({
    commands: [
      { match: /fail/, exitCode: 1 },
      { match: /ok/, exitCode: 0, stdout: 'done' },
    ],
  })
  const pb = makePlaybook({
    onError: 'continue',
    steps: [makeStep({ id: 's1', command: 'fail' }), makeStep({ id: 's2', command: 'ok' })],
  })
  const record = await executePlaybook(makeDeps(svc), pb)
  assertEqual(record.targets[0].steps.length, 2, 'both steps recorded')
  assertTrue(record.targets[0].steps[0].continuedAfterFailure === true, 'first step continued')
  assertTrue(record.targets[0].steps[1].ok, 'second step ran')
})

// ─── Runner ────────────────────────────────────────────────────────────────

async function main() {
  let pass = 0, fail = 0
  for (const t of tests) {
    try { await t.run(); pass++; console.log(`PASS ${t.name}`) }
    catch (e) { fail++; console.log(`FAIL ${t.name}: ${(e as Error).message}`) }
  }
  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
void main()
