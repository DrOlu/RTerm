import { register, resolveConfig, normalizeRecord, parseNdjson, buildDeployCommand } from './index.mjs'

const cases = []
function test(n, r) { cases.push({ name: n, run: r }) }
function assert(c, m) { if (!c) throw new Error(m ?? 'assertion failed') }
function eq(a, b, m) { if (a !== b) throw new Error(`${m ?? 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

function mkCtx(settings = {}, extra = {}) {
  const tools = new Map(); const triggers = []; const panels = []; const logs = []; const emitted = []
  const ctx = {
    settings: { numbat: settings },
    registerTool: (t) => tools.set(t.name, t),
    registerTrigger: (t) => triggers.push(t),
    registerPanel: (p) => panels.push(p),
    log: (l) => logs.push(l),
    emitEvent: (e) => emitted.push(e),
    ...extra,
  }
  return { tools, triggers, panels, logs, emitted, ctx }
}

const CFG = { minSeverity: 'low' }

// ─── config ─────────────────────────────────────────────────────────────────

test('resolveConfig defaults', () => {
  const c = resolveConfig({ settings: {} }, {})
  eq(c.binaryPath, 'numbat', 'default binary')
  eq(c.minSeverity, 'low', 'default minSeverity')
  eq(c.enabled, true, 'enabled default')
  assert(c.recordsPath.includes('.numbat'), 'records path under ~/.numbat')
})

// ─── normalizeRecord ────────────────────────────────────────────────────────

test('normalizeRecord maps a finding record', () => {
  const rec = { record_type: 'finding', severity: 'high', rule_id: 'cloud-metadata', agent: 'codex', host: 'web-01', summary: 'metadata access' }
  const n = normalizeRecord(rec, CFG)
  eq(n.source, 'numbat', 'source')
  eq(n.recordType, 'finding', 'type')
  eq(n.severity, 'high', 'severity')
  eq(n.ruleId, 'cloud-metadata', 'ruleId')
  eq(n.agent, 'codex', 'agent')
  eq(n.host, 'web-01', 'host')
})

test('normalizeRecord drops low-signal raw events (noise)', () => {
  const rec = { record_type: 'event', severity: 'info', summary: 'routine' }
  eq(normalizeRecord(rec, CFG), null, 'info event dropped')
})

test('normalizeRecord keeps high-severity events', () => {
  const rec = { record_type: 'event', severity: 'critical', summary: 'metadata 169.254.169.254' }
  const n = normalizeRecord(rec, CFG)
  assert(n, 'critical event kept')
  eq(n.severity, 'critical', 'severity')
})

test('normalizeRecord enforces minSeverity', () => {
  const rec = { record_type: 'finding', severity: 'low', rule_id: 'x' }
  eq(normalizeRecord(rec, { minSeverity: 'high' }), null, 'low finding below high threshold dropped')
  assert(normalizeRecord(rec, { minSeverity: 'low' }), 'low finding at low threshold kept')
})

// ─── parseNdjson ────────────────────────────────────────────────────────────

test('parseNdjson parses multiple records, skips malformed', () => {
  const nd = [
    JSON.stringify({ record_type: 'finding', severity: 'high', rule_id: 'r1', agent: 'codex' }),
    'not json',
    JSON.stringify({ record_type: 'event', severity: 'info' }),
    JSON.stringify({ record_type: 'indicator', severity: 'medium', rule_id: 'r2' }),
  ].join('\n')
  const out = parseNdjson(nd, CFG)
  eq(out.length, 2, 'two findings (finding + indicator; info event + malformed dropped)')
  eq(out[0].ruleId, 'r1', 'first rule')
  eq(out[1].recordType, 'indicator', 'second type')
})

// ─── buildDeployCommand ─────────────────────────────────────────────────────

test('buildDeployCommand builds correct argv per action', () => {
  eq(JSON.stringify(buildDeployCommand('inventory')), JSON.stringify(['agents']), 'inventory')
  eq(JSON.stringify(buildDeployCommand('scan', { agent: 'codex' })), JSON.stringify(['scan', '--agent', 'codex']), 'scan')
  eq(JSON.stringify(buildDeployCommand('install-monitor', { agent: 'codex' })), JSON.stringify(['hook', 'install', '--agent', 'codex', '--emit', 'all']), 'install-monitor')
  const en = buildDeployCommand('install-enforce', { agent: 'codex', rulesDir: './policy' })
  assert(en.includes('--enforce'), 'enforce flag')
  assert(en.includes('--rules-dir'), 'rules-dir flag')
  eq(JSON.stringify(buildDeployCommand('status', { agent: 'codex' })), JSON.stringify(['hook', 'status', '--agent', 'codex']), 'status')
})

test('buildDeployCommand throws on unknown action', () => {
  let threw = false
  try { buildDeployCommand('bogus') } catch { threw = true }
  assert(threw, 'expected throw')
})

// ─── register wiring ────────────────────────────────────────────────────────

test('register wires 4 tools, 1 trigger, 1 panel', () => {
  const { tools, triggers, panels, ctx } = mkCtx()
  register(ctx)
  eq(tools.size, 4, 'tool count')
  for (const n of ['numbat_health', 'numbat_deploy', 'numbat_ingest', 'numbat_findings_summary']) assert(tools.has(n), `missing ${n}`)
  eq(triggers.length, 1, 'trigger count')
  eq(triggers[0].name, 'numbat_finding', 'trigger name')
  eq(panels.length, 1, 'panel count')
})

// ─── ingest → trigger ───────────────────────────────────────────────────────

test('numbat_ingest normalizes + emits a trigger event per finding', async () => {
  const { tools, emitted, ctx } = mkCtx()
  register(ctx)
  const nd = [
    JSON.stringify({ record_type: 'finding', severity: 'high', rule_id: 'cloud-metadata', agent: 'codex', host: 'web-01' }),
    JSON.stringify({ record_type: 'finding', severity: 'medium', rule_id: 'r2', agent: 'cursor' }),
  ].join('\n')
  const r = await tools.get('numbat_ingest').handler({ ndjson: nd })
  eq(r.ingested, 2, 'ingested count')
  eq(emitted.length, 2, 'emitted events')
  eq(emitted[0].source, 'numbat', 'event source')
  eq(emitted[0].ruleId, 'cloud-metadata', 'event ruleId')
})

// ─── trigger match ──────────────────────────────────────────────────────────

test('numbat_finding trigger matches numbat-source medium+ severity', () => {
  const { triggers, ctx } = mkCtx()
  register(ctx)
  const t = triggers[0]
  assert(t.match({ source: 'numbat', severity: 'high' }), 'matches high')
  assert(t.match({ source: 'numbat', severity: 'medium' }), 'matches medium')
  assert(!t.match({ source: 'numbat', severity: 'low' }), 'rejects low')
  assert(!t.match({ source: 'other', severity: 'high' }), 'rejects other source')
})

// ─── runner ─────────────────────────────────────────────────────────────────
async function main() {
  let pass = 0, fail = 0
  for (const c of cases) {
    try { await c.run(); pass++; console.log(`PASS ${c.name}`) }
    catch (e) { fail++; console.log(`FAIL ${c.name}: ${e?.message ?? e}`) }
  }
  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
main()
