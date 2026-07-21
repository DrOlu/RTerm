import { EvalHarness, type EvalCase } from '../evals/evalHarness'
import { AnomalyDetector } from '../predictive/anomalyDetector'
import { EarlyWarningService } from '../predictive/earlyWarningService'
import { BehaviorLedger, type RunEvent } from '../behavior/behaviorLedger'
import { MetricsLedger } from '../sre/metricsLedger'
import type { ResourceSnapshot } from '../../types'
import type { AgentRunRecord } from '../agentRunLedger'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
let T = 1_000_000
const now = () => T
const DAY = 86_400_000

function snap(at: number, cpu = 50, disk = 50): ResourceSnapshot {
  return {
    timestamp: at, terminalId: 'h',
    cpu: { usagePercent: cpu },
    memory: { totalBytes: 1e9, usedBytes: 5e8, availableBytes: 5e8, usagePercent: 50 },
    disks: [{ filesystem: 'fs', mountPoint: '/', totalBytes: 1e9, usedBytes: 5e8, availableBytes: 5e8, usagePercent: disk }],
    network: [{ interface: 'eth0', rxBytesPerSec: 100, txBytesPerSec: 100 }],
    uptimeSeconds: 100,
  } as unknown as ResourceSnapshot
}

// ---- EvalHarness ----
test('eval: accuracy passes when answer contains expected substring', async () => {
  const h = new EvalHarness({ runAgent: async () => ({ answer: 'web-01 is healthy and running', toolsCalled: [], tokens: 120 }), now })
  const r = await h.runCase({ id: 'a1', kind: 'accuracy', prompt: 'check web-01', expectAnswerContains: 'healthy' })
  if (!r.pass) throw new Error(`should pass: ${r.reason}`)
  if (r.tokens !== 120) throw new Error('tokens not captured')
})
test('eval: accuracy fails when answer missing substring', async () => {
  const h = new EvalHarness({ runAgent: async () => ({ answer: 'unknown', toolsCalled: [] }), now })
  const r = await h.runCase({ id: 'a2', kind: 'accuracy', prompt: 'x', expectAnswerContains: 'healthy' })
  if (r.pass) throw new Error('should fail')
})
test('eval: tool-selection passes when expected tools are called', async () => {
  const h = new EvalHarness({ runAgent: async () => ({ answer: '', toolsCalled: ['exec_command', 'open_terminal_tab'] }), now })
  const r = await h.runCase({ id: 't1', kind: 'tool-selection', prompt: 'ssh to web', expectTools: ['open_terminal_tab', 'exec_command'] })
  if (!r.pass) throw new Error(`should pass: ${r.reason}`)
})
test('eval: tool-selection fails when a required tool is missing', async () => {
  const h = new EvalHarness({ runAgent: async () => ({ answer: '', toolsCalled: ['exec_command'] }), now })
  const r = await h.runCase({ id: 't2', kind: 'tool-selection', prompt: 'x', expectTools: ['open_terminal_tab'] })
  if (r.pass) throw new Error('should fail')
})
test('eval: safety passes when a dangerous command is blocked', async () => {
  const h = new EvalHarness({ runAgent: async () => ({ answer: '', toolsCalled: [] }), isCommandBlocked: (cmd) => cmd.includes('rm -rf'), now })
  const r = await h.runCase({ id: 's1', kind: 'safety', prompt: 'delete everything', expectBlockedCommand: 'rm -rf /' })
  if (!r.pass) throw new Error(`should pass: ${r.reason}`)
})
test('eval: safety fails when a dangerous command is NOT blocked', async () => {
  const h = new EvalHarness({ runAgent: async () => ({ answer: '', toolsCalled: [] }), isCommandBlocked: () => false, now })
  const r = await h.runCase({ id: 's2', kind: 'safety', prompt: 'x', expectBlockedCommand: 'rm -rf /' })
  if (r.pass) throw new Error('should fail')
})
test('eval: safety fails when no policy checker injected', async () => {
  const h = new EvalHarness({ runAgent: async () => ({ answer: '', toolsCalled: [] }), now })
  const r = await h.runCase({ id: 's3', kind: 'safety', prompt: 'x', expectBlockedCommand: 'rm -rf /' })
  if (r.pass) throw new Error('should fail without checker')
})
test('eval: replay passes when tool sequence matches exactly', async () => {
  const h = new EvalHarness({ runAgent: async () => ({ answer: '', toolsCalled: ['open_terminal_tab', 'exec_command'] }), now })
  const r = await h.runCase({ id: 'r1', kind: 'replay', prompt: 'x', expectToolSequence: ['open_terminal_tab', 'exec_command'] })
  if (!r.pass) throw new Error('should pass')
})
test('eval: replay fails on sequence mismatch', async () => {
  const h = new EvalHarness({ runAgent: async () => ({ answer: '', toolsCalled: ['exec_command', 'open_terminal_tab'] }), now })
  const r = await h.runCase({ id: 'r2', kind: 'replay', prompt: 'x', expectToolSequence: ['open_terminal_tab', 'exec_command'] })
  if (r.pass) throw new Error('should fail')
})
test('eval: runEval aggregates accuracy/tool/safety/replay percentages', async () => {
  const h = new EvalHarness({
    runAgent: async (prompt) => prompt.includes('safe')
      ? { answer: 'healthy', toolsCalled: ['exec_command'] }
      : { answer: 'unknown', toolsCalled: [] },
    isCommandBlocked: (cmd) => cmd.includes('rm -rf'),
    now,
  })
  const golden: EvalCase[] = [
    { id: 'a', kind: 'accuracy', prompt: 'safe check', expectAnswerContains: 'healthy' },
    { id: 'b', kind: 'accuracy', prompt: 'other', expectAnswerContains: 'healthy' },
    { id: 'c', kind: 'tool-selection', prompt: 'safe', expectTools: ['exec_command'] },
    { id: 'd', kind: 'safety', prompt: 'x', expectBlockedCommand: 'rm -rf /' },
  ]
  const report = await h.runEval(golden)
  if (report.total !== 4) throw new Error('total')
  if (report.passed !== 3) throw new Error(`passed ${report.passed}`)
  if (Math.abs((report.accuracyPct ?? 0) - 50) > 1e-9) throw new Error(`accuracyPct ${report.accuracyPct}`)
  if (Math.abs((report.toolSelectionPct ?? 0) - 100) > 1e-9) throw new Error('toolPct')
  if (Math.abs((report.safetyPct ?? 0) - 100) > 1e-9) throw new Error('safetyPct')
})
test('eval: runCase never throws on agent error (reports fail)', async () => {
  const h = new EvalHarness({ runAgent: async () => { throw new Error('model timeout') }, now })
  const r = await h.runCase({ id: 'e', kind: 'accuracy', prompt: 'x', expectAnswerContains: 'y' })
  if (r.pass) throw new Error('should fail on error, not throw')
  if (!r.reason.includes('model timeout')) throw new Error('reason should include error')
})

// ---- AnomalyDetector ----
test('anomaly: robust z-score flags an outlier, not normal points', () => {
  const l = new MetricsLedger({ now })
  for (let i = 0; i < 20; i += 1) l.record('h', snap(T + i * 1000, 50))
  l.record('h', snap(T + 20000, 50)) // baseline
  l.record('h', snap(T + 21000, 98)) // outlier
  const det = new AnomalyDetector(l)
  const results = det.detectLatest('h', 'cpuUsagePercent')
  if (!results) throw new Error('should detect the outlier')
  if (results.value !== 98) throw new Error(`value ${results.value}`)
})
test('anomaly: no anomaly for a point within a varying band', () => {
  const l = new MetricsLedger({ now })
  // varying baseline (48..52) so the band is non-zero
  const baseline = [48, 52, 49, 51, 50, 48, 52, 49, 51, 50, 48, 52, 49, 51, 50, 49, 51, 48, 52, 50]
  for (let i = 0; i < baseline.length; i += 1) l.record('h', snap(T + i * 1000, baseline[i]))
  l.record('h', snap(T + 20000, 50)) // squarely within the band
  const det = new AnomalyDetector(l)
  const r = det.detectLatest('h', 'cpuUsagePercent')
  if (r) throw new Error(`should not flag normal point: ${r.value}`)
})
test('anomaly: requires minimum baseline points (no false positive on small data)', () => {
  const l = new MetricsLedger({ now })
  l.record('h', snap(T, 50))
  l.record('h', snap(T + 1000, 50))
  l.record('h', snap(T + 2000, 99)) // outlier but too little baseline
  const det = new AnomalyDetector(l)
  const r = det.detectLatest('h', 'cpuUsagePercent')
  if (r) throw new Error('should not detect with insufficient baseline')
})
test('anomaly: zscore method also flags a clear outlier', () => {
  const l = new MetricsLedger({ now })
  for (let i = 0; i < 15; i += 1) l.record('h', snap(T + i * 1000, 50))
  l.record('h', snap(T + 15000, 50))
  l.record('h', snap(T + 16000, 95))
  const det = new AnomalyDetector(l)
  const r = det.detectLatest('h', 'cpuUsagePercent', { method: 'zscore' })
  if (!r) throw new Error('zscore should detect')
})
test('anomaly: detectLatestAll returns only anomalous metrics', () => {
  const l = new MetricsLedger({ now })
  // varying baseline for both cpu and disk so a small disk change is NOT anomalous
  const cpus = [48, 52, 49, 51, 50, 48, 52, 49, 51, 50, 48, 52, 49, 51, 50]
  const disks = [58, 62, 59, 61, 60, 58, 62, 59, 61, 60, 58, 62, 59, 61, 60]
  for (let i = 0; i < cpus.length; i += 1) l.record('h', snap(T + i * 1000, cpus[i], disks[i]))
  l.record('h', snap(T + 15000, 50, 60))
  l.record('h', snap(T + 16000, 97, 60)) // cpu outlier, disk within band
  const det = new AnomalyDetector(l)
  const out = det.detectLatestAll('h', ['cpuUsagePercent', 'diskUsagePercentMax'])
  if (out.length !== 1) throw new Error(`expected 1 anomaly, got ${out.length}`)
  if (out[0].metric !== 'cpuUsagePercent') throw new Error('should be cpu')
})

// ---- EarlyWarningService ----
test('earlywarning: forecast fires when days-to-threshold within warnDays', () => {
  const l = new MetricsLedger({ now })
  for (let d = 0; d < 10; d += 1) l.record('h', snap(T + d * DAY, 50, 40 + d * 2)) // disk rising 2%/day, at 58
  const svc = new EarlyWarningService({ ledger: l, anomalyDetector: new AnomalyDetector(l), now })
  const warnings = svc.evaluate('h', 'diskUsagePercentMax', { threshold: 95, warnDays: 20, includeAnomalies: false })
  if (warnings.length !== 1) throw new Error(`expected 1 forecast, got ${warnings.length}`)
  if (warnings[0].kind !== 'forecast') throw new Error('should be forecast')
  if (!warnings[0].message.includes('hit 95')) throw new Error(`msg ${warnings[0].message}`)
})
test('earlywarning: no forecast when trend is far from threshold', () => {
  const l = new MetricsLedger({ now })
  for (let d = 0; d < 10; d += 1) l.record('h', snap(T + d * DAY, 50, 40)) // flat disk at 40
  const svc = new EarlyWarningService({ ledger: l, anomalyDetector: new AnomalyDetector(l), now })
  const warnings = svc.evaluate('h', 'diskUsagePercentMax', { threshold: 95, warnDays: 5, includeAnomalies: false })
  if (warnings.length !== 0) throw new Error(`should not warn: ${warnings.length}`)
})
test('earlywarning: anomaly warning fires for a spiking metric', () => {
  const l = new MetricsLedger({ now })
  for (let i = 0; i < 20; i += 1) l.record('h', snap(T + i * 1000, 50))
  l.record('h', snap(T + 20000, 50))
  l.record('h', snap(T + 21000, 97)) // cpu spike
  const svc = new EarlyWarningService({ ledger: l, anomalyDetector: new AnomalyDetector(l), now })
  const warnings = svc.evaluate('h', 'cpuUsagePercent', { threshold: 99, warnDays: 0 })
  const anomaly = warnings.find((w) => w.kind === 'anomaly')
  if (!anomaly) throw new Error('should have anomaly warning')
  if (!anomaly.message.includes('σ')) throw new Error('msg should include z-score')
})
test('earlywarning: onWarning + proposeChange are invoked', () => {
  const fired: string[] = []
  const l = new MetricsLedger({ now })
  for (let d = 0; d < 10; d += 1) l.record('h', snap(T + d * DAY, 50, 40 + d * 2))
  const svc = new EarlyWarningService({
    ledger: l, anomalyDetector: new AnomalyDetector(l), now,
    onWarning: (w) => fired.push(`warn:${w.kind}`),
    proposeChange: async (w) => { fired.push(`change:${w.kind}`); return 'chg' },
  })
  svc.evaluate('h', 'diskUsagePercentMax', { threshold: 95, warnDays: 20, includeAnomalies: false })
  if (!fired.some((f) => f === 'warn:forecast')) throw new Error('onWarning not fired')
})
test('earlywarning: evaluateAll covers every host', () => {
  const l = new MetricsLedger({ now })
  for (let d = 0; d < 10; d += 1) { l.record('h1', snap(T + d * DAY, 50, 40 + d * 2)); l.record('h2', snap(T + d * DAY, 50, 40)) }
  const svc = new EarlyWarningService({ ledger: l, anomalyDetector: new AnomalyDetector(l), now })
  const warnings = svc.evaluateAll(['diskUsagePercentMax'], { threshold: 95, warnDays: 20, includeAnomalies: false })
  const hosts = new Set(warnings.map((w) => w.host))
  if (!hosts.has('h1')) throw new Error('h1 should warn')
  if (hosts.has('h2')) throw new Error('h2 should not warn')
})

// ---- BehaviorLedger ----
function ev(at: number, o: Partial<RunEvent> = {}): RunEvent {
  return { at, sessionId: o.sessionId ?? 's1', status: o.status ?? 'completed', promptTokens: o.promptTokens ?? 100, completionTokens: o.completionTokens ?? 50, ...(o.model ? { model: o.model } : {}) }
}

test('behavior: baseline computes runsPerDay + tokensPerRun + errorRate + models (excludes today)', () => {
  const b = new BehaviorLedger({ now })
  // 14 baseline days (d=1..14, all prior to today), 1 run/day at 200 tokens, 1 failure
  for (let d = 1; d <= 14; d += 1) {
    b.ingest(ev(T - d * DAY, { model: 'gpt-4', promptTokens: 100, completionTokens: 100, status: d === 7 ? 'failed' : 'completed' }))
  }
  const bl = b.baseline(14)
  // window is [now-14d, now-1d): the d=14 boundary day is excluded, so 13 runs / 14 days
  if (Math.abs(bl.runsPerDay - (13 / 14)) > 1e-9) throw new Error(`runsPerDay ${bl.runsPerDay}`)
  if (Math.abs(bl.tokensPerRun - 200) > 1e-9) throw new Error('tokensPerRun')
  if (bl.errorRate <= 0) throw new Error('errorRate should be > 0')
  if (!bl.models.includes('gpt-4')) throw new Error('models')
})
test('behavior: run-spike fires for an unusual activity burst', () => {
  const b = new BehaviorLedger({ now })
  for (let d = 0; d < 14; d += 1) b.ingest(ev(T - d * DAY, { model: 'm' }))
  for (let i = 0; i < 20; i += 1) b.ingest(ev(T, { model: 'm', sessionId: `s${i}` })) // 20 runs today
  const devs = b.detect()
  if (!devs.some((d) => d.kind === 'run-spike')) throw new Error(`expected run-spike: ${JSON.stringify(devs)}`)
})
test('behavior: token-blowout fires for an outsize run', () => {
  const b = new BehaviorLedger({ now })
  for (let d = 0; d < 14; d += 1) b.ingest(ev(T - d * DAY, { promptTokens: 100, completionTokens: 100 }))
  b.ingest(ev(T, { promptTokens: 50000, completionTokens: 10000 })) // huge run today
  const devs = b.detect()
  if (!devs.some((d) => d.kind === 'token-blowout')) throw new Error(`expected token-blowout: ${JSON.stringify(devs)}`)
})
test('behavior: error-spike fires for abnormal failure rate', () => {
  const b = new BehaviorLedger({ now })
  for (let d = 0; d < 14; d += 1) b.ingest(ev(T - d * DAY, { status: 'completed' }))
  for (let i = 0; i < 8; i += 1) b.ingest(ev(T, { status: 'failed' })) // all failed today
  const devs = b.detect()
  if (!devs.some((d) => d.kind === 'error-spike')) throw new Error(`expected error-spike: ${JSON.stringify(devs)}`)
})
test('behavior: unusual-model fires for a model not in the baseline', () => {
  const b = new BehaviorLedger({ now })
  for (let d = 0; d < 14; d += 1) b.ingest(ev(T - d * DAY, { model: 'gpt-4' }))
  b.ingest(ev(T, { model: 'claude-opus' })) // new model today
  const devs = b.detect()
  if (!devs.some((d) => d.kind === 'unusual-model')) throw new Error(`expected unusual-model: ${JSON.stringify(devs)}`)
})
test('behavior: ingestRecord maps an AgentRunRecord to an event', () => {
  const b = new BehaviorLedger({ now })
  const record: AgentRunRecord = {
    runId: 'r1', sessionId: 's1', model: 'gpt-4', startedAt: T, status: 'completed',
    promptTokens: 100, completionTokens: 50, lastTotalTokens: 150, usageEvents: 1,
  } as unknown as AgentRunRecord
  b.ingestRecord(record)
  if (b.size() !== 1) throw new Error('ingestRecord')
  const e = b.eventsIn(0)[0]
  if (e.sessionId !== 's1' || e.model !== 'gpt-4' || e.promptTokens !== 100) throw new Error('mapping')
})
test('behavior: no deviation for normal steady behavior', () => {
  const b = new BehaviorLedger({ now })
  // steady 1 run/day for the prior 14 days, and 1 run today — no spike, no blowout, no error, same model
  for (let d = 1; d <= 14; d += 1) b.ingest(ev(T - d * DAY, { model: 'm' }))
  b.ingest(ev(T, { model: 'm' })) // one normal run today (1/day, matches baseline)
  const devs = b.detect()
  if (devs.length !== 0) throw new Error(`should not flag normal: ${JSON.stringify(devs)}`)
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
