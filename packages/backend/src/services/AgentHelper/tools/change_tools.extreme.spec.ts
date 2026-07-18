import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { manageChange, manageChangeSchema } from './change_tools'
import { runPlaybook } from './playbook_tools'
import { ChangeLedger } from '../../changeLedger'
import { AutomationManager } from '../../automation/AutomationManager'
import type { ToolExecutionContext } from '../types'
import type { ScheduledTaskTerminalService } from '../../automation/scheduledTaskRunner'
import type { TerminalConfig } from '../../../types'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(`ASSERT: ${msg}`) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'change-tools-spec-'))

interface FakeTerm { id: string; runtimeState?: string; config: TerminalConfig; ran: string[]; failOn: string[] }
const makeTerminalService = () => {
  const terminals: FakeTerm[] = []
  const service: ScheduledTaskTerminalService = {
    createTerminal: async (config: TerminalConfig) => {
      const t: FakeTerm = { id: config.id, runtimeState: 'ready', config, ran: [], failOn: [] }
      terminals.push(t)
      return { id: t.id }
    },
    runCommandAndWait: async (terminalId: string, command: string) => {
      const t = terminals.find((x) => x.id === terminalId)!
      t.ran.push(command)
      if (t.failOn.some((f) => command.includes(f))) return { stdoutDelta: 'error out', exitCode: 1 }
      return { stdoutDelta: 'all good Established', exitCode: 0 }
    },
    kill: () => {},
    getAllTerminals: () => terminals,
  }
  return { service, terminals }
}

const makeCtx = () => {
  let settings: any = { automation: undefined }
  const automationManager = new AutomationManager({
    getSettings: () => settings,
    setSettings: (patch: any) => { settings = { ...settings, ...patch } },
  })
  const ledger = new ChangeLedger({ filePath: path.join(tmp, `c-${Math.random().toString(36).slice(2)}.sqlite`) })
  const { service, terminals } = makeTerminalService()
  const ctx = {
    sessionId: 'sess-1',
    messageId: 'msg-1',
    sendEvent: () => {},
    automationManager,
    changeLedger: ledger,
    terminalService: service,
    savedSshConnections: [],
    savedWinrmConnections: [],
    savedSerialConnections: [],
    savedProxies: [],
    savedTunnels: [],
  } as unknown as ToolExecutionContext
  return { ctx, automationManager, ledger, terminals }
}

const seedMopPlaybook = (m: AutomationManager, requireApproval = true) =>
  m.createPlaybook({
    name: 'core-mop',
    steps: [
      { id: 's1', kind: 'command', command: 'apply acl', rollback: { kind: 'command', command: 'remove acl' }, validate: { command: 'verify bgp', expect: 'Established' } },
      { id: 's2', kind: 'command', command: 'save config', rollback: { kind: 'command', command: 'restore config' } },
    ],
    requireApproval,
  })

test('full lifecycle: plan → approve → run → committed, with events in the ledger', async () => {
  const { ctx, automationManager, ledger, terminals } = makeCtx()
  const pb = seedMopPlaybook(automationManager)
  const plan = await manageChange({ action: 'plan', playbookId: pb.id }, ctx)
  assert(plan.includes('status=planned'), 'plan created')
  const changeId = plan.match(/change (chg-\S+) for/)![1]
  const ap = await manageChange({ action: 'approve', changeId, approvedBy: 'olu' }, ctx)
  assert(ap.includes('approved by olu'), 'approved with approver')
  const run = await manageChange({ action: 'run', changeId }, ctx)
  assert(run.includes('status=committed'), `committed, got: ${run.split('\n')[0]}`)
  const got = ledger.getChange(changeId)!
  assert(got.change.status === 'committed', 'ledger committed')
  assert(got.change.approvedBy === 'olu', 'approver persisted')
  const phases = got.steps.map((s) => s.phase)
  assert(phases.filter((p) => p === 'execute').length === 2, 'two execute events')
  assert(phases.includes('validate'), 'validate event recorded')
  assert(terminals[0].ran.includes('verify bgp'), 'validation command ran')
  ledger.close()
})

test('run without approval is refused; double-approve is refused', async () => {
  const { ctx, automationManager, ledger } = makeCtx()
  seedMopPlaybook(automationManager)
  const plan = await manageChange({ action: 'plan', name: 'core-mop' }, ctx)
  const changeId = plan.match(/change (chg-\S+) for/)![1]
  const run = await manageChange({ action: 'run', changeId }, ctx)
  assert(run.includes('must be approved'), 'run refused while planned')
  assert(ledger.getChange(changeId)!.change.status === 'planned', 'still planned')
  await manageChange({ action: 'approve', changeId }, ctx)
  const again = await manageChange({ action: 'approve', changeId }, ctx)
  assert(again.includes('only planned changes can be approved'), 'second approve refused')
  ledger.close()
})

test('validation failure during run → rolled_back with rollback events', async () => {
  const { ctx, automationManager, ledger, terminals } = makeCtx()
  const pb = seedMopPlaybook(automationManager)
  const plan = await manageChange({ action: 'plan', playbookId: pb.id }, ctx)
  const changeId = plan.match(/change (chg-\S+) for/)![1]
  await manageChange({ action: 'approve', changeId }, ctx)
  // Make the validation check output miss the pattern by failing 'verify bgp' with exit 1? No —
  // validation matches output, so instead fail step 2 ('save config') → unwind runs.
  const orig = ctx.terminalService.runCommandAndWait.bind(ctx.terminalService)
  ctx.terminalService.runCommandAndWait = (async (id: string, cmd: string) => {
    if (cmd.includes('save config')) return { stdoutDelta: 'write failed', exitCode: 1 }
    return orig(id, cmd)
  }) as never
  const run = await manageChange({ action: 'run', changeId }, ctx)
  assert(run.includes('status=rolled_back'), `rolled_back, got: ${run.split('\n')[0]}`)
  const got = ledger.getChange(changeId)!
  assert(got.change.status === 'rolled_back', 'ledger rolled_back')
  const rbPhases = got.steps.filter((s) => s.phase === 'rollback')
  assert(rbPhases.length === 2, 'both rollbacks recorded')
  assert(rbPhases[0].stepIndex === 1 && rbPhases[1].stepIndex === 0, 'reverse order recorded')
  assert(terminals[0].ran.indexOf('restore config') < terminals[0].ran.indexOf('remove acl'), 'undo order on device')
  ledger.close()
})

test('MOP-mode playbook refused by run_playbook with guidance', async () => {
  const { ctx, automationManager } = makeCtx()
  const pb = seedMopPlaybook(automationManager, true)
  const out = await runPlaybook({ id: pb.id }, ctx)
  assert(out.includes('MOP mode') && out.includes('manage_change'), 'refusal points to manage_change')
})

test('non-MOP playbook still runs via run_playbook', async () => {
  const { ctx, automationManager } = makeCtx()
  const pb = seedMopPlaybook(automationManager, false)
  const out = await runPlaybook({ id: pb.id }, ctx)
  assert(out.includes('completed OK'), `plain run works, got: ${out.split('\n')[0]}`)
})

test('status + list report the change trail; unknown change handled', async () => {
  const { ctx, automationManager, ledger } = makeCtx()
  const pb = seedMopPlaybook(automationManager)
  const plan = await manageChange({ action: 'plan', playbookId: pb.id }, ctx)
  const changeId = plan.match(/change (chg-\S+) for/)![1]
  const status = await manageChange({ action: 'status', changeId }, ctx)
  assert(status.includes('status=planned') && status.includes('core-mop'), 'status shows plan')
  const list = await manageChange({ action: 'list', status: 'planned' }, ctx)
  assert(list.includes(changeId), 'list contains the change')
  const missing = await manageChange({ action: 'status', changeId: 'chg-nope' }, ctx)
  assert(missing.includes('No change'), 'unknown id handled')
  ledger.close()
})

test('schema rejects bad input (unknown action, bad limit)', () => {
  let threw = false
  try { manageChangeSchema.parse({ action: 'yolo' }) } catch { threw = true }
  assert(threw, 'bad action rejected')
  threw = false
  try { manageChangeSchema.parse({ action: 'list', limit: 99999 }) } catch { threw = true }
  assert(threw, 'limit > 500 rejected')
  const ok = manageChangeSchema.parse({ action: 'approve', changeId: 'chg-1', approvedBy: 'olu' })
  assert(ok.action === 'approve', 'valid parse')
})

// --- runner ---
;(async () => {
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
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${pass}/${cases.length} passed`)
  if (failed.length) process.exit(1)
})()
