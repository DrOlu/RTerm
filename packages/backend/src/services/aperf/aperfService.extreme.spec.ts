import {
  AperfService, parseAperfReport, buildInstallCommand, buildPrereqCommand,
  buildRecordCommand, buildReportCommand, buildReadReportCommand, aperfSummaryToMetricPoint,
  APERF_CATEGORIES, type AperfResult,
} from './aperfService'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

// ---- command builders ----
test('buildInstallCommand downloads + extracts + chmods the aperf binary', () => {
  const c = buildInstallCommand()
  if (!c.includes('curl') || !c.includes('tar -xz') || !c.includes('chmod +x')) throw new Error('install cmd incomplete')
  if (!c.includes('aws/aperf/releases/latest')) throw new Error('should fetch latest release')
})
test('buildPrereqCommand sets perf_event_paranoid (tolerant of failure)', () => {
  const c = buildPrereqCommand()
  if (!c.includes('kernel.perf_event_paranoid=-1')) throw new Error('prereq')
  if (!c.includes('|| true')) throw new Error('should tolerate failure')
})
test('buildRecordCommand builds record with interval + period', () => {
  const c = buildRecordCommand({ runName: 'r1', intervalSec: 2, periodSec: 120, hostDir: '/tmp/aperf' })
  if (!c.includes('record -r r1') || !c.includes('-i 2') || !c.includes('-p 120')) throw new Error(`record cmd ${c}`)
})
test('buildRecordCommand includes categories when provided', () => {
  const c = buildRecordCommand({ runName: 'r1', intervalSec: 1, periodSec: 60, hostDir: '/tmp/aperf', categories: ['cpu_utilization', 'vmstat'] })
  if (!c.includes('--include cpu_utilization,vmstat')) throw new Error('categories')
})
test('buildReportCommand builds report with run + report name', () => {
  const c = buildReportCommand({ runName: 'r1', intervalSec: 1, periodSec: 60, hostDir: '/tmp/aperf' }, 'r1-report')
  if (!c.includes('report -r r1') || !c.includes('-n r1-report')) throw new Error('report cmd')
})
test('buildReadReportCommand reads the report index/html', () => {
  const c = buildReadReportCommand('r1-report')
  if (!c.includes('index.html') && !c.includes('.txt')) throw new Error('read cmd')
})

// ---- parseAperfReport ----
test('parse: extracts cpu/mem/disk utilization from the report', () => {
  const text = 'cpu_utilization  aggregate  87.3\n' +
    'vmstat  memory utilization  65.2\n' +
    'diskstats  /dev/nvme0n1  45.1\n' +
    'diskstats  /dev/nvme1n1  72.4\n'
  const { summary } = parseAperfReport(text)
  if (summary.cpuUsagePercent !== 87.3) throw new Error(`cpu ${summary.cpuUsagePercent}`)
  if (summary.memUsagePercent !== 65.2) throw new Error(`mem ${summary.memUsagePercent}`)
  if (summary.diskUsagePercentMax !== 72.4) throw new Error(`disk max ${summary.diskUsagePercentMax}`)
})
test('parse: takes the max disk utilization across disks', () => {
  const text = 'diskstats  /dev/sda  30\n' + 'diskstats  /dev/sdb  88\n'
  const { summary } = parseAperfReport(text)
  if (summary.diskUsagePercentMax !== 88) throw new Error('should take max disk')
})
test('parse: extracts top CPU processes', () => {
  const text = 'java  62.5\npython  30.1\nnginx  8.0\n'
  const { summary } = parseAperfReport(text)
  if (!summary.topCpuProcesses || summary.topCpuProcesses.length === 0) throw new Error('no top procs')
  if (summary.topCpuProcesses[0].name !== 'java' || summary.topCpuProcesses[0].cpuPercent !== 62.5) throw new Error('top proc wrong')
})
test('parse: synthesizes a critical finding for CPU >= 90', () => {
  const { findings } = parseAperfReport('cpu_utilization  aggregate  95')
  const crit = findings.find((f) => f.metric === 'cpu_utilization' && f.severity === 'critical')
  if (!crit) throw new Error('should flag critical cpu')
})
test('parse: synthesizes a warning finding for CPU >= 75 and < 90', () => {
  const { findings } = parseAperfReport('cpu_utilization  aggregate  80')
  const warn = findings.find((f) => f.metric === 'cpu_utilization' && f.severity === 'warning')
  if (!warn) throw new Error('should flag warning cpu')
})
test('parse: synthesizes critical findings for mem/disk >= 90', () => {
  const { findings } = parseAperfReport('vmstat  memory utilization  95\ndiskstats  /dev/sda  92')
  if (!findings.some((f) => f.metric === 'memory' && f.severity === 'critical')) throw new Error('mem critical')
  if (!findings.some((f) => f.metric === 'disk' && f.severity === 'critical')) throw new Error('disk critical')
})
test('parse: flags a top process using >= 50% of one CPU', () => {
  const { findings } = parseAperfReport('java  62.5\n')
  if (!findings.some((f) => f.metric.startsWith('process:') && f.severity === 'warning')) throw new Error('process flag')
})
test('parse: no findings for healthy metrics', () => {
  const { findings } = parseAperfReport('cpu_utilization  aggregate  20\nvmstat  memory utilization  30\ndiskstats  /dev/sda  40\n')
  if (findings.length !== 0) throw new Error(`should have no findings, got ${findings.length}`)
})
test('parse: empty report returns empty summary + no findings', () => {
  const { summary, findings } = parseAperfReport('')
  if (Object.keys(summary).length !== 0) throw new Error('empty summary should be empty')
  if (findings.length !== 0) throw new Error('empty findings should be empty')
})

// ---- aperfSummaryToMetricPoint ----
test('aperfSummaryToMetricPoint flattens the summary for the metrics ledger', () => {
  const result: AperfResult = {
    host: 'h1', runName: 'r1', reportPath: '/tmp/x',
    summary: { cpuUsagePercent: 80, memUsagePercent: 60, diskUsagePercentMax: 50 },
    findings: [], reportText: '', at: 0,
  }
  const p = aperfSummaryToMetricPoint(result)
  if (p.host !== 'h1' || p.cpuUsagePercent !== 80 || p.memoryUsagePercent !== 60 || p.diskUsagePercentMax !== 50) throw new Error('flatten')
})
test('aperfSummaryToMetricPoint omits missing metrics', () => {
  const result: AperfResult = { host: 'h1', runName: 'r1', reportPath: '/tmp/x', summary: {}, findings: [], reportText: '', at: 0 }
  const p = aperfSummaryToMetricPoint(result)
  if ('cpuUsagePercent' in p) throw new Error('should omit missing cpu')
})

// ---- AperfService.deepDive (injected exec) ----
test('deepDive: installs, records, reports, parses, and returns the result', async () => {
  const cmds: string[] = []
  const svc = new AperfService({
    execSsh: async (cmd) => {
      cmds.push(cmd)
      if (cmd.includes('record -r')) return 'recording...'
      if (cmd.includes('report -r')) return 'reporting...'
      if (cmd.includes('index.html') || cmd.includes('.txt')) return 'cpu_utilization  aggregate  87.3\nvmstat  memory utilization  65.2\ndiskstats  /dev/sda  45.1\njava  62.5\n'
      return 'ok'
    },
    now: () => 1000,
  })
  const result = await svc.deepDive('web-01', { periodSec: 30 })
  if (result.host !== 'web-01') throw new Error('host')
  if (result.summary.cpuUsagePercent !== 87.3) throw new Error('cpu parse')
  if (result.summary.memUsagePercent !== 65.2) throw new Error('mem parse')
  if (result.summary.diskUsagePercentMax !== 45.1) throw new Error('disk parse')
  if (!result.findings.some((f) => f.metric.startsWith('process:'))) throw new Error('process finding')
  // verify the pipeline order: install (curl) -> prereq -> record -> report -> read
  const order: string[] = cmds.map((c) => (c.includes('curl') ? 'install' : c.includes('perf_event_paranoid') ? 'prereq' : c.includes('record -r') ? 'record' : c.includes('report -r') ? 'report' : c.includes('index.html') ? 'read' : '?'))
  const idx = (s: string) => order.indexOf(s)
  if (!(idx('install') < idx('prereq') && idx('prereq') < idx('record') && idx('record') < idx('report') && idx('report') < idx('read'))) {
    throw new Error(`pipeline order wrong: ${order.join(',')}`)
  }
})

test('deepDive: skips install when aperf is already present (fileExists true)', async () => {
  const cmds: string[] = []
  const svc = new AperfService({
    execSsh: async (cmd) => { cmds.push(cmd); return cmd.includes('index.html') ? 'cpu_utilization  aggregate  20' : 'ok' },
    fileExists: async () => true,
    now: () => 1000,
  })
  await svc.deepDive('web-01')
  if (cmds.some((c) => c.includes('curl'))) throw new Error('should NOT reinstall when present')
})

test('deepDive: tolerant of prereq failure (continues)', async () => {
  let recordRan = false
  const svc = new AperfService({
    execSsh: async (cmd) => {
      if (cmd.includes('perf_event_paranoid')) throw new Error('sysctl denied')
      if (cmd.includes('record -r')) recordRan = true
      return cmd.includes('index.html') ? 'cpu_utilization  aggregate  10' : 'ok'
    },
    now: () => 1000,
  })
  await svc.deepDive('web-01')
  if (!recordRan) throw new Error('should continue after prereq failure')
})

test('APERF_CATEGORIES includes the key aperf data categories', () => {
  for (const c of ['cpu_utilization', 'vmstat', 'diskstats', 'perf_stat', 'processes', 'meminfo', 'hotline']) {
    if (!APERF_CATEGORIES.includes(c as any)) throw new Error(`missing category ${c}`)
  }
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
