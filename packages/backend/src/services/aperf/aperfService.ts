import { randomUUID } from 'crypto'

/**
 * aperfService — AWS APerf performance deep-dive.
 *
 * Deploys the aperf CLI to a host via SSH, records system performance metrics
 * (CPU, memory, disk, network, PMU counters, processes, hotspot data), generates
 * the aperf analysis report, and parses the findings into structured results that
 * RTerm ingests into the metrics ledger + agent RCA — combining aperf's deep
 * profiling with RTerm's agent reasoning and SRE pillar.
 *
 * Pure + injectable: SSH exec, file download, and aperf download are injected;
 * command-building and report-parsing are pure and fully testable.
 */

// --- aperf data categories it collects ---
export const APERF_CATEGORIES = [
  'cpu_utilization', 'vmstat', 'diskstats', 'interrupts', 'perf_stat',
  'processes', 'netstat', 'meminfo', 'memalloc', 'hotline', 'aperf_stats',
] as const

export type AperfCategory = (typeof APERF_CATEGORIES)[number]

export interface AperfRunPlan {
  runName: string
  /** sampling interval in seconds (default 1). */
  intervalSec: number
  /** total sampling period in seconds (default 60). */
  periodSec: number
  /** aperf binary dir on the host (default /tmp/aperf). */
  hostDir: string
  /** categories to include (default: all). */
  categories?: AperfCategory[]
}

export interface AperfFinding {
  metric: string
  /** the observed value (e.g. cpu utilization %). */
  value: number
  /** a threshold the value was compared against (when aperf flags it). */
  threshold?: number
  /** aperf's severity hint (info/warning/critical). */
  severity: 'info' | 'warning' | 'critical'
  message: string
}

export interface AperfResult {
  host: string
  runName: string
  /** the aperf report archive path (the generated report dir). */
  reportPath: string
  /** parsed key metrics (flattened summary). */
  summary: {
    cpuUsagePercent?: number
    memUsagePercent?: number
    diskUsagePercentMax?: number
    topCpuProcesses?: Array<{ name: string; cpuPercent: number }>
  }
  /** aperf findings (potential performance issues aperf flagged). */
  findings: AperfFinding[]
  /** the raw report text (for the agent's RCA). */
  reportText: string
  at: number
}

export interface AperfDeps {
  /** run a command on the host (SSH exec). Returns stdout text. */
  execSsh: (command: string) => Promise<string>
  /** check whether a file/dir exists on the host. */
  fileExists?: (path: string) => Promise<boolean>
  /** download the aperf binary for the host arch (default: curl the release). */
  downloadAperf?: (hostDir: string) => Promise<void>
  now?: () => number
}

const DEFAULT_HOST_DIR = '/tmp/aperf'
const DEFAULT_INTERVAL = 1
const DEFAULT_PERIOD = 60

/** Pure: build the command to download + extract the aperf binary on the host. */
export function buildInstallCommand(hostDir = DEFAULT_HOST_DIR): string {
  return `mkdir -p ${hostDir} && cd ${hostDir} && ` +
    `arch=$(uname -m) && ` +
    `curl -sL $(curl -s https://api.github.com/repos/aws/aperf/releases/latest | grep "browser_download_url.*$arch.*\\\\.tar\\\\.gz" | cut -d'"' -f4) | tar -xz && ` +
    `chmod +x ./aperf-*/aperf && ls ./aperf-*/aperf`
}

/** Pure: build the sysctl prerequisite command (aperf needs perf_event access). */
export function buildPrereqCommand(): string {
  return 'sudo sysctl -w kernel.perf_event_paranoid=-1 2>/dev/null || true'
}

/** Pure: build the aperf record command. */
export function buildRecordCommand(plan: AperfRunPlan): string {
  const bin = `${plan.hostDir}/aperf-*/aperf`
  const cats = plan.categories && plan.categories.length > 0 ? ` --include ${plan.categories.join(',')}` : ''
  return `${bin} record -r ${plan.runName} -i ${plan.intervalSec} -p ${plan.periodSec}${cats}`
}

/** Pure: build the aperf report command. */
export function buildReportCommand(plan: AperfRunPlan, reportName: string): string {
  const bin = `${plan.hostDir}/aperf-*/aperf`
  return `${bin} report -r ${plan.runName} -n ${reportName}`
}

/** Pure: build the command to dump the report's stats text (for parsing). */
export function buildReadReportCommand(reportName: string): string {
  return `cat ${reportName}/index.html 2>/dev/null || cat ${reportName}/*.txt 2>/dev/null || echo ''`
}

/** Pure: parse aperf report/stats text into a summary + findings. Tolerant of the
 * aperf stats table format (metric value lines) and simple heuristics for flags. */
export function parseAperfReport(text: string): { summary: AperfResult['summary']; findings: AperfFinding[] } {
  const summary: AperfResult['summary'] = {}
  const findings: AperfFinding[] = []
  const topProcs: Array<{ name: string; cpuPercent: number }> = []

  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const l = line.trim()

    // CPU utilization (aggregate): "cpu_utilization ... 87.3" or "CPU Utilization: 87.3%"
    const cpuM = l.match(/cpu[_ ]utilization[^\d]*(\d+(?:\.\d+)?)\s*%?/i)
    if (cpuM && summary.cpuUsagePercent === undefined) {
      summary.cpuUsagePercent = parseFloat(cpuM[1])
    }
    // Memory utilization
    const memM = l.match(/mem(?:ory)?[_ ]utili[sz]ation[^\d]*(\d+(?:\.\d+)?)\s*%?/i) || l.match(/vmstat[^\d]*(\d+(?:\.\d+)?)\s*%?/i)
    if (memM && summary.memUsagePercent === undefined) {
      summary.memUsagePercent = parseFloat(memM[1])
    }
    // Disk utilization (max across disks): "diskstats /dev/x 72.4" — take the LAST
    // numeric token on the line (the device path may itself contain digits).
    const diskM = l.match(/disk(?:stats)?\b/i)
    if (diskM) {
      const nums = l.match(/(\d+(?:\.\d+)?)\s*%?$/i)
      if (nums) {
        const v = parseFloat(nums[1])
        if (summary.diskUsagePercentMax === undefined || v > summary.diskUsagePercentMax) {
          summary.diskUsagePercentMax = v
        }
      }
    }
    // Top CPU process: a bare "name number" line with no other content, e.g. "java 62.5".
    // Require a non-device, non-metric word followed only by a number at end of line.
    if (!/cpu|mem|disk|util|stat|interrupt|hotline|alloc/i.test(l)) {
      const procM = l.match(/^([A-Za-z][A-Za-z0-9_.-]*)\s+(\d+(?:\.\d+)?)\s*%?$/)
      if (procM && !/^(dev|sda|sdb|nvme|hd|sr|loop|dm)/i.test(procM[1])) {
        topProcs.push({ name: procM[1], cpuPercent: parseFloat(procM[2]) })
      }
    }
    // aperf warning/critical flags: lines containing WARN/CRIT/FAIL
    const sevM = l.match(/\b(critical|crit|warn(?:ing)?|fail)\b/i)
    if (sevM && l.length > 8) {
      const sev = /crit|fail/i.test(sevM[1]) ? 'critical' : 'warning'
      const numM = l.match(/(\d+(?:\.\d+)?)\s*%?/)
      findings.push({
        metric: l.split(/\s{2,}/)[0].slice(0, 40),
        value: numM ? parseFloat(numM[1]) : 0,
        severity: sev as AperfFinding['severity'],
        message: l.slice(0, 160),
      })
    }
  }

  // Top processes by CPU (desc, top 5).
  topProcs.sort((a, b) => b.cpuPercent - a.cpuPercent)
  if (topProcs.length > 0) summary.topCpuProcesses = topProcs.slice(0, 5)

  // Synthesize findings from summary metrics when aperf didn't emit explicit flags.
  if (findings.length === 0) {
    const cpu = summary.cpuUsagePercent
    if (cpu !== undefined && cpu >= 90) {
      findings.push({ metric: 'cpu_utilization', value: cpu, severity: 'critical', message: `aggregate CPU utilization is ${cpu}% (>= 90%)` })
    } else if (cpu !== undefined && cpu >= 75) {
      findings.push({ metric: 'cpu_utilization', value: cpu, severity: 'warning', message: `aggregate CPU utilization is ${cpu}% (>= 75%)` })
    }
    const mem = summary.memUsagePercent
    if (mem !== undefined && mem >= 90) {
      findings.push({ metric: 'memory', value: mem, severity: 'critical', message: `memory utilization is ${mem}% (>= 90%)` })
    }
    const disk = summary.diskUsagePercentMax
    if (disk !== undefined && disk >= 90) {
      findings.push({ metric: 'disk', value: disk, severity: 'critical', message: `a disk is at ${disk}% utilization (>= 90%)` })
    }
    if (summary.topCpuProcesses && summary.topCpuProcesses.length > 0) {
      const top = summary.topCpuProcesses[0]
      if (top.cpuPercent >= 50) {
        findings.push({ metric: `process:${top.name}`, value: top.cpuPercent, severity: 'warning', message: `top CPU process "${top.name}" is using ${top.cpuPercent}% of one CPU` })
      }
    }
  }

  return { summary, findings }
}

export class AperfService {
  private readonly now: () => number

  constructor(private readonly deps: AperfDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /** Full deep-dive: install aperf if needed, record, report, parse, return. */
  async deepDive(host: string, opts: { intervalSec?: number; periodSec?: number; categories?: AperfCategory[] } = {}): Promise<AperfResult> {
    const runName = `rterm-${randomUUID().slice(0, 8)}`
    const plan: AperfRunPlan = {
      runName,
      intervalSec: opts.intervalSec ?? DEFAULT_INTERVAL,
      periodSec: opts.periodSec ?? DEFAULT_PERIOD,
      hostDir: DEFAULT_HOST_DIR,
      ...(opts.categories ? { categories: opts.categories } : {}),
    }

    // 1. ensure aperf is installed on the host.
    const installed = this.deps.fileExists ? await this.deps.fileExists(`${DEFAULT_HOST_DIR}/aperf-*/aperf`).catch(() => false) : false
    if (!installed) {
      if (this.deps.downloadAperf) {
        await this.deps.downloadAperf(DEFAULT_HOST_DIR)
      } else {
        await this.deps.execSsh(buildInstallCommand(DEFAULT_HOST_DIR))
      }
    }

    // 2. prerequisites (perf_event access).
    await this.deps.execSsh(buildPrereqCommand()).catch(() => '')

    // 3. record.
    await this.deps.execSsh(buildRecordCommand(plan))

    // 4. report.
    const reportName = `${runName}-report`
    await this.deps.execSsh(buildReportCommand(plan, reportName))

    // 5. read + parse the report.
    const reportText = await this.deps.execSsh(buildReadReportCommand(reportName)).catch(() => '')
    const { summary, findings } = parseAperfReport(reportText)

    return {
      host,
      runName,
      reportPath: `${DEFAULT_HOST_DIR}/${reportName}`,
      summary,
      findings,
      reportText: reportText.slice(0, 8000),
      at: this.now(),
    }
  }
}

/** Flatten an aperf summary into metric-ledger-friendly point fields. */
export function aperfSummaryToMetricPoint(result: AperfResult): { host: string; cpuUsagePercent?: number; memoryUsagePercent?: number; diskUsagePercentMax?: number } {
  return {
    host: result.host,
    ...(result.summary.cpuUsagePercent !== undefined ? { cpuUsagePercent: result.summary.cpuUsagePercent } : {}),
    ...(result.summary.memUsagePercent !== undefined ? { memoryUsagePercent: result.summary.memUsagePercent } : {}),
    ...(result.summary.diskUsagePercentMax !== undefined ? { diskUsagePercentMax: result.summary.diskUsagePercentMax } : {}),
  }
}
