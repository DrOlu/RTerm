import { createRequire } from 'node:module'
import type { TerminalService } from './TerminalService'
import type { AgentService_v2 } from './AgentService_v2'
import type { AutomationManager } from './automation/AutomationManager'
import type { AgentRunLedger } from './agentRunLedger'
import type { GatewayService } from './Gateway/GatewayService'
import { MetricsLedger } from './sre/metricsLedger'
import { GoldenSignals } from './sre/goldenSignals'
import { SloService } from './sre/sloService'
import { UptimeWatchdog } from './sre/uptimeWatchdog'
import { AlertService, type AlertChannel } from './sre/alertService'
import { IncidentLedger } from './sre/incidentLedger'
import { SyntheticChecks } from './sre/syntheticChecks'
import { DriftDetector } from './sre/driftDetector'
import { SpanLedger } from './apm/spanLedger'
import { RumLedger } from './dem/rumLedger'
import { InfraMonitor } from './infra/infraMonitor'
import { EtwService } from './etw/etwService'
import { DashboardService } from './dashboard/dashboardService'
import { slackChannel, teamsChannel, smtpChannel, telegramChannel } from './notify/notifyService'
import { parseDaguYaml, parseDaguWorkflow, daguExecutionPlan } from './dagu/daguParser'
import { PluginRegistry } from './plugin/pluginRegistry'
import { EvalHarness } from './evals/evalHarness'
import { AnomalyDetector } from './predictive/anomalyDetector'
import { EarlyWarningService } from './predictive/earlyWarningService'
import { BehaviorLedger } from './behavior/behaviorLedger'
import { AperfService, aperfSummaryToMetricPoint } from './aperf/aperfService'
import { AuditLedger } from './audit/auditLedger'
import { EvidenceSealer } from './audit/evidenceSealer'
import { MonitorStatusService } from './sre/monitorStatusService'

/**
 * Observability — central wiring for every SRE/APM/DEM/ETW/evals/predictive/
 * behavior module (v2.0.0–v2.3.0). Constructs them, feeds them live data from
 * the monitor snapshot channel, wires notifications (Slack/Teams/SMTP/Telegram)
 * and the dashboard, and exposes them to the gateway so they're callable over RPC.
 *
 * This is what makes the new modules live in the runtime (esbuild no longer
 * tree-shakes them out) and composable: monitor snapshots → metrics ledger →
 * golden signals / anomaly / early-warning → alerts (notify) → incidents, all
 * feeding the unified dashboard.
 */

export interface ObservabilityDeps {
  terminalService: TerminalService
  agentService: AgentService_v2
  automationManager: AutomationManager
  agentRunLedger: AgentRunLedger
  gatewayService: GatewayService
  /** the resource monitor service (injected; used for monitor status diagnostics). */
  resourceMonitorService: import('./ResourceMonitorService').ResourceMonitorService
  /** monitor snapshot publisher (injected; called with 'monitor:snapshot' events). */
  setMonitorPublisher: (pub: (channel: string, data: unknown) => void) => void
  /** notification channels to wire (slack/teams/smtp/telegram). */
  alertChannels?: AlertChannel[]
  /** run agent for eval harness (injected; offline mock or online). */
  runAgentForEval?: (prompt: string) => Promise<{ answer: string; toolsCalled: string[]; tokens?: number }>
  onLog?: (line: string) => void
}

export interface Observability {
  metricsLedger: MetricsLedger
  goldenSignals: GoldenSignals
  sloService: SloService
  uptimeWatchdog: UptimeWatchdog
  alertService: AlertService
  incidentLedger: IncidentLedger
  syntheticChecks: SyntheticChecks
  driftDetector: DriftDetector
  spanLedger: SpanLedger
  rumLedger: RumLedger
  infraMonitor: InfraMonitor
  etwService: EtwService
  dashboard: DashboardService
  evalHarness: EvalHarness
  anomalyDetector: AnomalyDetector
  earlyWarning: EarlyWarningService
  behaviorLedger: BehaviorLedger
  /** dagu workflow support: compile dagu YAML workflows into playbooks. */
  dagu: {
    parseDaguYaml: typeof parseDaguYaml
    parseDaguWorkflow: typeof parseDaguWorkflow
    daguExecutionPlan: typeof daguExecutionPlan
  }
  /** notification channel factories (slack/teams/smtp/telegram). */
  notify: {
    slackChannel: typeof slackChannel
    teamsChannel: typeof teamsChannel
    smtpChannel: typeof smtpChannel
    telegramChannel: typeof telegramChannel
  }
  /** AWS APerf performance deep-dive (v2.6.0): deploy + record + parse aperf on hosts. */
  aperf: {
    service: AperfService
    /** flatten an aperf result into a metric-ledger-friendly point. */
    toMetricPoint: typeof aperfSummaryToMetricPoint
  }
  /** Hash-chained audit ledger + evidence sealing (v2.7.1): tamper-evident audit trail. */
  audit: {
    ledger: AuditLedger
    sealer: EvidenceSealer
  }
  /** Monitor status diagnostic (v2.7.6): reports why stats aren't displaying per terminal. */
  monitorStatus: MonitorStatusService
  /** the plugin system registry (v2.5.0). */
  pluginRegistry: PluginRegistry
}

export function createObservability(deps: ObservabilityDeps): Observability {
  const log = deps.onLog ?? (() => {})

  // --- SRE core ---
  const metricsLedger = new MetricsLedger({})
  const goldenSignals = new GoldenSignals({ ledger: metricsLedger })
  const incidentLedger = new IncidentLedger({})
  const alertService = new AlertService({ channels: deps.alertChannels ?? [] })
  const sloService = new SloService({
    source: { count: async () => ({ good: 0, total: 0 }) },
  })
  const uptimeWatchdog = new UptimeWatchdog({
    onTransition: (status, from, to) => {
      log(`[watchdog] ${status.target.name}: ${from} -> ${to}`)
      void alertService.fire({
        fingerprint: `watchdog:${status.target.name}:${to}`,
        title: `${status.target.name} is ${to}`,
        severity: to === 'down' ? 'critical' : 'warning',
        source: 'watchdog',
        detail: status.lastError,
        labels: { host: status.target.name, state: to },
        at: Date.now(),
      })
      if (to === 'down') {
        incidentLedger.create({
          title: `${status.target.name} down`,
          severity: 'sev2',
          affected: [status.target.name],
          source: 'watchdog',
          detectText: status.lastError ?? 'liveness probe failed',
        })
      }
    },
  })
  const syntheticChecks = new SyntheticChecks({})
  const driftDetector = new DriftDetector({
    render: async () => '',
    getActual: async () => '',
  })

  // --- APM / DEM / Infra / ETW ---
  const spanLedger = new SpanLedger({})
  const rumLedger = new RumLedger({})
  const infraMonitor = new InfraMonitor({})
  const etwService = new EtwService({})

  // --- Dashboard ---
  const dashboard = new DashboardService({
    metricsLedger, goldenSignals, sloService, uptimeWatchdog, incidentLedger,
    spanLedger, rumLedger, infraMonitor,
  })

  // --- Predictive + behavior + evals ---
  const anomalyDetector = new AnomalyDetector(metricsLedger)
  const earlyWarning = new EarlyWarningService({
    ledger: metricsLedger,
    anomalyDetector,
    onWarning: (w) => {
      void alertService.fire({
        fingerprint: `earlywarning:${w.host}:${w.metric}:${w.kind}`,
        title: w.message,
        severity: w.kind === 'anomaly' ? 'warning' : 'info',
        source: 'early-warning',
        labels: { host: w.host, metric: w.metric, kind: w.kind },
        at: w.at,
      })
    },
  })
  const behaviorLedger = new BehaviorLedger({})
  const evalHarness = new EvalHarness({
    runAgent: deps.runAgentForEval ?? (async (_prompt) => ({ answer: '', toolsCalled: [] })),
    isCommandBlocked: () => false,
  })

  // --- APerf performance deep-dive (v2.6.0): deploy + record + parse aperf on hosts ---
  // The execSsh is a no-op default; the agent tool or playbook injects the real
  // SSH exec (bound to the target host's terminalId) at call time.
  const aperfService = new AperfService({
    execSsh: async () => '',
  })

  // --- Audit ledger + evidence sealing (v2.7.1): tamper-evident audit trail ---
  const auditLedger = new AuditLedger({})
  const evidenceSealer = new EvidenceSealer({})

  // --- Monitor status diagnostic (v2.7.6): reports why stats aren't displaying ---
  const monitorStatus = new MonitorStatusService(deps.resourceMonitorService, deps.terminalService)

  // --- Plugin system (v2.5.0): discover + auto-integrate custom plugins from plugins/. ---
  const pluginScanRoot = (process.env.GYBACKEND_DATA_DIR ?? './.gybackend-data') + '/plugins'
  // Also scan the bundle's own plugins/ directory (for the rterm-backend npm package,
  // where plugins ship alongside the gybackend binary). The bundle is at bin/gybackend.js,
  // so the plugins are at ../plugins/ relative to the bundle file. We check that the
  // directory actually exists before adding it (in the source/unbundled case it won't).
  const bundlePluginRoot = new URL('../../plugins/', import.meta.url).pathname
  const scanRoots = [pluginScanRoot, './plugins']
  try {
    const req = createRequire(import.meta.url)
    const fs = req('node:fs') as typeof import('node:fs')
    if (fs.existsSync(bundlePluginRoot)) scanRoots.push(bundlePluginRoot)
  } catch { /* best-effort */ }
  // Also scan the Electron app's resources/plugins/ directory (for the desktop app,
  // where plugins are shipped as electron-builder extraResources). process.resourcesPath
  // is set by Electron to {app}/Contents/Resources (macOS) or {app}/resources (Windows/Linux).
  try {
    const req = createRequire(import.meta.url)
    const fs = req('node:fs') as typeof import('node:fs')
    const path = req('node:path') as typeof import('node:path')
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    if (resourcesPath) {
      const resourcesPlugins = path.join(resourcesPath, 'plugins')
      if (fs.existsSync(resourcesPlugins)) scanRoots.push(resourcesPlugins)
    }
  } catch { /* best-effort */ }
  const pluginRegistry = new PluginRegistry({
    scanRoots,
    createContext: (record) => PluginRegistry.defaultContext(
      record,
      async (cmd, opts) => deps.agentService
        ? `exec(${cmd} on ${opts?.host ?? 'local'})`
        : '',
      (name) => {
        if (name === 'metrics') return metricsLedger.hosts()
        if (name === 'incidents') return incidentLedger.list()
        return {}
      },
      (line) => { try { deps.onLog?.(line) } catch { /* best-effort */ } },
    ),
    onLog: deps.onLog,
  })
  void pluginRegistry.reload().catch(() => {})

  // --- Feed monitor snapshots into the metrics ledger + behavior (the live data path) ---
  deps.setMonitorPublisher((channel: string, data: unknown) => {
    if (channel !== 'monitor:snapshot' || !data || typeof data !== 'object') return
    const d = data as { terminalId?: string } & Record<string, unknown>
    const host = d.terminalId ? String(d.terminalId) : 'local'
    try {
      metricsLedger.record(host, d as never)
    } catch { /* best-effort */ }
  })

  return {
    metricsLedger, goldenSignals, sloService, uptimeWatchdog, alertService,
    incidentLedger, syntheticChecks, driftDetector, spanLedger, rumLedger,
    infraMonitor, etwService, dashboard, evalHarness, anomalyDetector,
    earlyWarning, behaviorLedger,
    dagu: { parseDaguYaml, parseDaguWorkflow, daguExecutionPlan },
    notify: { slackChannel, teamsChannel, smtpChannel, telegramChannel },
    aperf: { service: aperfService, toMetricPoint: aperfSummaryToMetricPoint },
    audit: { ledger: auditLedger, sealer: evidenceSealer },
    monitorStatus,
    pluginRegistry,
  }
}
