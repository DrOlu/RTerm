/**
 * agentspan-bridge.phase2.extreme.spec.ts — exhaustive offline tests for the
 * Phase-2 additions: playbookToWorkflowDef mapper (step→task mapping, DAG
 * edges, wait/rollback, retries), the conductorClient registerWorkflowDef /
 * getWorkflowDef methods, and the new tools (agentspan_export_playbook,
 * agentspan_register_playbook, agentspan_delegate) with mocked fetch. No network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConductorClient, DEFAULT_BASE_URL } from './conductorClient.mjs'
import {
  playbookToWorkflowDef,
  stepToTask,
  rollbackToTask,
  taskRef,
} from './playbookToWorkflowDef.mjs'
import { register, findPlaybook, buildDelegateAgentConfig } from './index.mjs'

// ─── mock fetch ─────────────────────────────────────────────────────────────
function mockFetch(respond) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    const r = typeof respond === 'function' ? respond(url, init) : respond
    return { ok: r.ok !== false && (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : '') }
  }
  fn.calls = calls
  return fn
}

const samplePlaybook = {
  id: 'pb-1',
  name: 'nightly backup',
  description: 'backup the core switch',
  steps: [
    { id: 'st-1', name: 'prep', kind: 'command', command: 'term length 0' },
    { id: 'st-2', name: 'collect', kind: 'script', scriptId: 'scr-9' },
    { id: 'st-3', name: 'settle', kind: 'wait', waitSeconds: 5 },
    { id: 'st-4', name: 'apply', kind: 'command', command: 'apply acl', rollback: { kind: 'command', command: 'no acl' }, dependsOn: ['st-1', 'st-2'] },
  ],
}

// ─── taskRef ────────────────────────────────────────────────────────────────
test('taskRef sanitizes to Conductor-safe refs', () => {
  assert.equal(taskRef('st-1'), 'st_1')
  assert.equal(taskRef('apply acl!'), 'apply_acl_')
  assert.equal(taskRef(undefined, 'fallback'), 'fallback')
  assert.equal(taskRef(''), 'step')
})

// ─── stepToTask ─────────────────────────────────────────────────────────────
test('command step → HTTP run_command task with command + validate', () => {
  const t = stepToTask({ id: 'st-1', kind: 'command', command: 'show run', validate: { expect: 'ok' } }, 0, {})
  assert.equal(t.type, 'HTTP')
  assert.equal(t.taskReferenceName, 'st_1')
  const req = t.inputParameters.http_request
  assert.equal(req.method, 'POST')
  assert.equal(req.body.kind, 'run_command')
  assert.equal(req.body.command, 'show run')
  assert.deepEqual(req.body.validate, { expect: 'ok' })
})

test('script step → SIMPLE script-reference task (scriptId, no inline body)', () => {
  const t = stepToTask({ id: 'st-2', kind: 'script', scriptId: 'scr-9', name: 'collect' }, 1, {})
  assert.equal(t.type, 'SIMPLE')
  assert.equal(t.inputParameters.kind, 'rterm_script')
  assert.equal(t.inputParameters.scriptId, 'scr-9')
  assert.equal(t.inputParameters.name, 'collect')
})

test('wait step → Conductor WAIT task with duration', () => {
  const t = stepToTask({ id: 'st-3', kind: 'wait', waitSeconds: 7 }, 2, {})
  assert.equal(t.type, 'WAIT')
  assert.equal(t.inputParameters.duration, 7)
})

test('onError=continue sets retryCount; stop (default) is 0', () => {
  const cont = stepToTask({ id: 'a', kind: 'command', command: 'x', onError: 'continue' }, 0, { continueRetryCount: 3 })
  assert.equal(cont.retryCount, 3)
  const stop = stepToTask({ id: 'b', kind: 'command', command: 'x' }, 1, {})
  assert.equal(stop.retryCount, 0)
})

// ─── rollbackToTask ─────────────────────────────────────────────────────────
test('rollback command → optional compensating HTTP task', () => {
  const t = rollbackToTask({ kind: 'command', command: 'no acl' }, 'st_4', 0)
  assert.equal(t.type, 'HTTP')
  assert.equal(t.optional, true)
  assert.equal(t.inputParameters.http_request.body.compensating, true)
  assert.match(t.taskReferenceName, /^rollback_st_4_/)
})

test('rollback script → optional compensating SIMPLE task', () => {
  const t = rollbackToTask({ kind: 'script', scriptId: 'undo' }, 'st_1', 1)
  assert.equal(t.type, 'SIMPLE')
  assert.equal(t.inputParameters.scriptId, 'undo')
  assert.equal(t.optional, true)
})

// ─── playbookToWorkflowDef: full mapping ────────────────────────────────────
test('maps all 4 steps + rollback compensating task in order', () => {
  const def = playbookToWorkflowDef(samplePlaybook, { execUri: 'http://gw:17888/rpc/exec' })
  assert.equal(def.name, 'nightly_backup')
  assert.equal(def.version, 1)
  assert.equal(def.schemaVersion, 2)
  assert.equal(def.restartable, true)
  // 4 step tasks + 1 JOIN (st-4 has 2 deps) + 1 rollback = 6
  const types = def.tasks.map((t) => t.type)
  assert.equal(types.filter((x) => x === 'JOIN').length, 1, 'one JOIN for the 2-dep step')
  assert.equal(types.filter((x) => x === 'WAIT').length, 1, 'one WAIT')
  const rollback = def.tasks[def.tasks.length - 1]
  assert.equal(rollback.optional, true, 'last task is the compensating rollback')
  assert.equal(rollback.inputParameters.http_request.body.command, 'no acl')
})

test('JOIN carries the dependsOn edges (fan-in)', () => {
  const def = playbookToWorkflowDef(samplePlaybook, {})
  const join = def.tasks.find((t) => t.type === 'JOIN')
  assert.deepEqual(join.joinOn, ['st_1', 'st_2'])
  // the dependent task (st-4) appears after the JOIN in order
  const joinIdx = def.tasks.indexOf(join)
  const st4 = def.tasks.find((t) => t.taskReferenceName === 'st_4')
  assert.ok(def.tasks.indexOf(st4) > joinIdx, 'dependent task comes after its JOIN')
})

test('linear playbook (no dependsOn) emits no JOINs', () => {
  const pb = { name: 'linear', steps: [
    { id: 'a', kind: 'command', command: '1' },
    { id: 'b', kind: 'command', command: '2' },
    { id: 'c', kind: 'wait', waitSeconds: 1 },
  ] }
  const def = playbookToWorkflowDef(pb, {})
  assert.equal(def.tasks.filter((t) => t.type === 'JOIN').length, 0)
  assert.equal(def.tasks.length, 3)
})

test('multiple rollbacks run in reverse step order (undo newest first)', () => {
  const pb = { name: 'multi', steps: [
    { id: 'a', kind: 'command', command: 'a1', rollback: { kind: 'command', command: 'undo-a' } },
    { id: 'b', kind: 'command', command: 'b1', rollback: { kind: 'command', command: 'undo-b' } },
  ] }
  const def = playbookToWorkflowDef(pb, {})
  const rbs = def.tasks.filter((t) => t.optional)
  assert.equal(rbs.length, 2)
  assert.equal(rbs[0].inputParameters.http_request.body.command, 'undo-b', 'newest rollback first')
  assert.equal(rbs[1].inputParameters.http_request.body.command, 'undo-a')
})

test('execUri flows into the command tasks + inputTemplate', () => {
  const def = playbookToWorkflowDef(samplePlaybook, { execUri: 'http://gw:9000/exec' })
  const cmdTask = def.tasks.find((t) => t.type === 'HTTP')
  assert.equal(cmdTask.inputParameters.http_request.uri, 'http://gw:9000/exec')
  assert.equal(def.inputTemplate.rtermExecUri, 'http://gw:9000/exec')
})

test('rejects a playbook without steps', () => {
  assert.throws(() => playbookToWorkflowDef({ name: 'x' }), /steps array/)
  assert.throws(() => playbookToWorkflowDef(null), /steps array/)
})

// ─── conductorClient: registerWorkflowDef / getWorkflowDef ─────────────────
test('registerWorkflowDef POSTs an array to /api/metadata/workflow', async () => {
  const f = mockFetch({ json: {} })
  const c = new ConductorClient({ fetchImpl: f })
  const def = playbookToWorkflowDef(samplePlaybook, {})
  await c.registerWorkflowDef(def)
  const call = f.calls[0]
  assert.equal(call.url, `${DEFAULT_BASE_URL}/api/metadata/workflow`)
  assert.equal(call.init.method, 'POST')
  const body = JSON.parse(call.init.body)
  assert.ok(Array.isArray(body), 'body is an array of defs')
  assert.equal(body[0].name, 'nightly_backup')
})

test('registerWorkflowDef accepts an array + rejects empty', async () => {
  const c = new ConductorClient({ fetchImpl: mockFetch({ json: {} }) })
  await assert.rejects(() => c.registerWorkflowDef(), /WorkflowDef/)
})

test('getWorkflowDef GETs by name (+version)', async () => {
  const f = mockFetch({ json: { name: 'x', version: 2 } })
  const c = new ConductorClient({ fetchImpl: f })
  await c.getWorkflowDef('nightly_backup', 2)
  assert.match(f.calls[0].url, /\/api\/metadata\/workflow\/nightly_backup\?version=2$/)
  await assert.rejects(() => c.getWorkflowDef(), /name/)
})

// ─── index helpers: findPlaybook / buildDelegateAgentConfig ────────────────
test('findPlaybook resolves from AutomationManager then settings, by id or name', () => {
  const pb = { id: 'pb-1', name: 'nightly' }
  const viaAm = findPlaybook({ automationManager: { getPlaybook: (x) => (x === 'pb-1' ? pb : undefined) } }, 'pb-1')
  assert.equal(viaAm.name, 'nightly')
  const viaSettings = findPlaybook({ settings: { automation: { playbooks: [pb] } } }, 'nightly')
  assert.equal(viaSettings.id, 'pb-1')
  assert.equal(findPlaybook({ settings: { automation: { playbooks: [] } } }, 'ghost'), undefined)
  assert.equal(findPlaybook({}, undefined), undefined)
})

test('buildDelegateAgentConfig builds a valid durable AgentConfig', () => {
  const c = buildDelegateAgentConfig('mybot', 'do the thing', { model: 'anthropic/claude-sonnet-4.6' })
  assert.equal(c.name, 'mybot')
  assert.equal(c.model, 'anthropic/claude-sonnet-4.6')
  assert.equal(c.input, 'do the thing')
  const def = buildDelegateAgentConfig(undefined, 't')
  assert.equal(def.name, 'rterm_delegate')
  assert.equal(def.model, 'openai/gpt-4o')
})

// ─── new tools (mocked server) ─────────────────────────────────────────────
function makeCtx(playbooks, fetchImpl) {
  const tools = new Map()
  const triggers = []
  const panels = []
  const ctx = {
    settings: { agentspan: { serverUrl: DEFAULT_BASE_URL }, automation: { playbooks } },
    registerTool: (t) => tools.set(t.name, t),
    registerTrigger: (t) => triggers.push(t),
    registerPanel: (p) => panels.push(p),
    log: () => {},
  }
  return { tools, ctx, fetchImpl }
}

test('registers 9 tools now (6 phase-1 + 3 phase-2)', () => {
  const { tools, ctx } = makeCtx([], null)
  register(ctx)
  assert.equal(tools.size, 9)
  for (const n of ['agentspan_export_playbook', 'agentspan_register_playbook', 'agentspan_delegate']) assert.ok(tools.has(n), `missing ${n}`)
})

test('agentspan_export_playbook returns the mapped def without registering', async () => {
  const posted = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => { posted.push(url); return { ok: true, status: 200, text: async () => '{}' } }
  const { tools, ctx } = makeCtx([samplePlaybook], null)
  register(ctx)
  const r = await tools.get('agentspan_export_playbook').handler({ playbook: 'nightly backup' })
  assert.equal(r.name, 'nightly_backup')
  assert.ok(r.taskCount >= 5)
  assert.ok(r.def.tasks.some((t) => t.type === 'WAIT'))
  assert.equal(posted.length, 0, 'export is pure — no HTTP calls')
  const missing = await tools.get('agentspan_export_playbook').handler({ playbook: 'ghost' })
  assert.match(missing.error, /not found/)
  globalThis.fetch = realFetch
})

test('agentspan_register_playbook registers the def on the server', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method })
    return { ok: true, status: 200, text: async () => '{}' }
  }
  const { tools, ctx } = makeCtx([samplePlaybook], null)
  register(ctx)
  const r = await tools.get('agentspan_register_playbook').handler({ playbook: 'nightly backup' })
  assert.equal(r.registered, true)
  assert.equal(r.name, 'nightly_backup')
  assert.equal(r.runWith.args.workflow, 'nightly_backup')
  assert.ok(calls.some((c) => c.url.endsWith('/api/metadata/workflow') && c.method === 'POST'))
  globalThis.fetch = realFetch
})

test('agentspan_delegate builds an AgentConfig and returns executionId + followUp', async () => {
  const realFetch = globalThis.fetch
  let postedBody
  globalThis.fetch = async (url, init) => {
    if (init.method === 'POST') postedBody = JSON.parse(init.body)
    return { ok: true, status: 200, text: async () => JSON.stringify({ executionId: 'exec-del-1' }) }
  }
  const { tools, ctx } = makeCtx([], null)
  register(ctx)
  const bad = await tools.get('agentspan_delegate').handler({})
  assert.match(bad.error, /prompt/)
  const r = await tools.get('agentspan_delegate').handler({ prompt: 'investigate the disk-full on web-01', model: 'openai/gpt-5.6-sol' })
  assert.equal(r.delegated, true)
  assert.equal(r.executionId, 'exec-del-1')
  assert.match(r.uiUrl, /\/execution\/exec-del-1$/)
  assert.equal(postedBody.model, 'openai/gpt-5.6-sol')
  assert.equal(postedBody.input, 'investigate the disk-full on web-01')
  globalThis.fetch = realFetch
})
