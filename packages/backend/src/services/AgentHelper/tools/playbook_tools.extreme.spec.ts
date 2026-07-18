import type { ToolExecutionContext } from '../types'
import { AutomationManager } from '../../automation/AutomationManager'
import { managePlaybook, runPlaybook } from './playbook_tools'
import type { ScheduledTaskTerminalService } from '../../automation/scheduledTaskRunner'
import type { TerminalConfig } from '../../../types'

const cases: Array<{ name: string; run: () => Promise<void> }> = []
function test(n: string, r: () => Promise<void>) { cases.push({ name: n, run: r }) }

function newManager() {
  let s: any = {
    automation: { groups: [], deviceMemory: [], scripts: [], scheduledTasks: [], templates: [], playbooks: [] },
    connections: { ssh: [], winrm: [], serial: [], proxies: [], tunnels: [] },
  }
  return new AutomationManager({ getSettings: () => s, setSettings: (p) => { s = { ...s, ...p, automation: p.automation ?? s.automation } } })
}

/** Fake terminal layer matching the ScheduledTaskTerminalService contract. */
function fakeTerminalService(opts?: { failOn?: string }) {
  const ran: Array<{ id: string; command: string }> = []
  const terminals: Array<{ id: string; runtimeState?: string }> = []
  const svc: ScheduledTaskTerminalService = {
    createTerminal: async (config: TerminalConfig) => {
      terminals.push({ id: config.id, runtimeState: 'ready' })
      return { id: config.id }
    },
    runCommandAndWait: async (terminalId: string, command: string) => {
      ran.push({ id: terminalId, command })
      if (opts?.failOn && command.includes(opts.failOn)) {
        return { stdoutDelta: 'err\n', exitCode: 1 }
      }
      return { stdoutDelta: 'ok\n', exitCode: 0 }
    },
    kill: () => {},
    getAllTerminals: () => terminals,
  }
  return { svc, ran }
}

function ctx(automation: AutomationManager | undefined, terminalService?: any): ToolExecutionContext {
  return {
    sessionId: 's', messageId: 'm',
    terminalService: terminalService ?? ({} as any),
    sendEvent: () => {},
    commandPolicyService: {} as any, commandPolicyMode: 'standard',
    automationManager: automation,
    savedSshConnections: [], savedWinrmConnections: [], savedSerialConnections: [],
    savedProxies: [], savedTunnels: [],
  } as any
}

test('manage_playbook create + list + get + delete lifecycle', async () => {
  const am = newManager()
  const created = await managePlaybook({
    action: 'create', name: 'backup pb',
    steps: [
      { kind: 'command', command: 'term length 0', name: 'prep' },
      { kind: 'command', command: 'show run', name: 'collect' },
      { kind: 'wait', waitSeconds: 2, name: 'settle' },
    ],
  }, ctx(am))
  if (!created.includes('backup pb') || !created.includes('id=')) throw new Error(created)
  const id = /id=(pb-[\w-]+)/.exec(created)?.[1]
  if (!id) throw new Error('no id in create output')

  const list = await managePlaybook({ action: 'list' }, ctx(am))
  if (!list.includes('backup pb') || !list.includes('3 step(s)')) throw new Error(list)

  const get = await managePlaybook({ action: 'get', id }, ctx(am))
  if (!get.includes('1. [command] prep') || !get.includes('3. [wait] settle')) throw new Error(get)
  if (!get.includes('local shell')) throw new Error('scope line missing: ' + get)

  // get by name (case-insensitive)
  const byName = await managePlaybook({ action: 'get', name: 'BACKUP PB' }, ctx(am))
  if (!byName.includes('backup pb')) throw new Error(byName)

  const del = await managePlaybook({ action: 'delete', id }, ctx(am))
  if (!del.includes('Deleted')) throw new Error(del)
  const empty = await managePlaybook({ action: 'list' }, ctx(am))
  if (!empty.includes('No playbooks')) throw new Error(empty)
})

test('manage_playbook update changes steps and metadata', async () => {
  const am = newManager()
  const created = await managePlaybook({ action: 'create', name: 'pb', steps: [{ kind: 'command', command: 'a' }] }, ctx(am))
  const id = /id=(pb-[\w-]+)/.exec(created)![1]
  const upd = await managePlaybook({ action: 'update', id, description: 'd2', steps: [{ kind: 'command', command: 'b' }, { kind: 'command', command: 'c' }] }, ctx(am))
  if (!upd.includes('2 step(s)')) throw new Error(upd)
  const get = await managePlaybook({ action: 'get', id }, ctx(am))
  if (!get.includes('b') || !get.includes('c')) throw new Error(get)
})

test('manage_playbook create validates input and reports errors (never throws)', async () => {
  const am = newManager()
  const missing = await managePlaybook({ action: 'create', name: 'x' }, ctx(am))
  if (!missing.includes('requires name + at least one step')) throw new Error(missing)
  const badStep = await managePlaybook({ action: 'create', name: 'x', steps: [{ kind: 'command' }] }, ctx(am))
  if (!badStep.includes('Could not create playbook')) throw new Error(badStep)
})

test('manage_playbook without store reports unavailable', async () => {
  const res = await managePlaybook({ action: 'list' }, ctx(undefined))
  if (!res.includes('not available')) throw new Error(res)
})

test('run_playbook executes steps and reports per-step results', async () => {
  const am = newManager()
  const { svc, ran } = fakeTerminalService()
  const created = await managePlaybook({
    action: 'create', name: 'deploy',
    steps: [
      { kind: 'command', command: 'copy run start', name: 'save' },
      { kind: 'command', command: 'show version', name: 'verify' },
    ],
  }, ctx(am, svc))
  const id = /id=(pb-[\w-]+)/.exec(created)![1]
  const res = await runPlaybook({ id }, ctx(am, svc))
  if (!res.includes('completed OK')) throw new Error(res)
  if (!res.includes('1. save — ok') || !res.includes('2. verify — ok')) throw new Error(res)
  if (ran.length !== 2 || ran[0].command !== 'copy run start') throw new Error(JSON.stringify(ran))
  // last-run status stamped
  const list = await managePlaybook({ action: 'list' }, ctx(am, svc))
  if (!list.includes('OK')) throw new Error('last-run stamp missing: ' + list)
})

test('run_playbook reports failures with stop semantics', async () => {
  const am = newManager()
  const { svc, ran } = fakeTerminalService({ failOn: 'risky' })
  const created = await managePlaybook({
    action: 'create', name: 'pb',
    steps: [
      { kind: 'command', command: 'risky op', name: 'boom' },
      { kind: 'command', command: 'never', name: 'skipped' },
    ],
  }, ctx(am, svc))
  const id = /id=(pb-[\w-]+)/.exec(created)![1]
  const res = await runPlaybook({ id }, ctx(am, svc))
  if (!res.includes('FAILED')) throw new Error(res)
  if (res.includes('skipped — ok')) throw new Error('second step should not run: ' + res)
  if (ran.length !== 1) throw new Error('only one command should have run')
})

test('run_playbook by name + unknown playbook error', async () => {
  const am = newManager()
  const { svc } = fakeTerminalService()
  await managePlaybook({ action: 'create', name: 'named pb', steps: [{ kind: 'command', command: 'x' }] }, ctx(am, svc))
  const res = await runPlaybook({ name: 'named pb' }, ctx(am, svc))
  if (!res.includes('completed OK')) throw new Error(res)
  const missing = await runPlaybook({ name: 'ghost' }, ctx(am, svc))
  if (!missing.includes('No playbook "ghost"')) throw new Error(missing)
})

test('run_playbook without store reports unavailable', async () => {
  const res = await runPlaybook({ id: 'x' }, ctx(undefined))
  if (!res.includes('not available')) throw new Error(res)
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
