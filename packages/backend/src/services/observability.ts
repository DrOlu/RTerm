import { createRequire } from 'node:module'
import path from 'node:path'
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
import { AgtPolicyEngine, parsePolicyYaml } from './governance/agtPolicyEngine'
import { ReviewService, createSkippedReviewResult, shouldSkipReview } from './review/reviewService'
import { PrometheusRegistry, registryFromHostMetrics } from './sre/prometheusExporter'
import { OtelExporter } from './sre/otelExporter'
import { SecretsVault } from './secrets/secretsVault'
import { EscalationService } from './oncall/escalationService'
import { CostBudgetService } from './cost/costBudgetService'
import { SessionRecorder } from './recording/sessionRecorder'
import { GitOpsService, type DesiredEntity } from './gitops/gitOpsService'
import { PlaybookVersioning, lintPlaybook, lintOk } from './automation/playbookVersioning'
import { CloudInventory } from './cloud/cloudInventory'
import { LiveDashboardHub } from './liveui/liveDashboardHub'

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
  /** run the review model (injected; offline mock or online). */
  runReviewModel?: (prompt: string) => Promise<{ verdict: 'approved' | 'needs_revision' | 'escalate'; issues: Array<{ dimension: 'correctness' | 'completeness' | 'safety' | 'compliance' | 'accuracy'; severity: 'info' | 'warning' | 'critical'; message: string }>; reasoning: string; confidence: number }>
  /** the review model's identity. */
  reviewerId?: string
  /** the review mode: strict (block on any issue), advisory (flag but allow), auto-approve (skip review for low-risk actions). */
  reviewMode?: 'strict' | 'advisory' | 'auto-approve'
  /** paging channels for incident escalation (v2.9.0). */
  pagingChannels?: import('./oncall/escalationService').PageChannel[]
  /** model price table for AI cost attribution (v2.9.0). */
  modelPrices?: import('./cost/costBudgetService').CostBudgetDeps['prices']
  /** GitOps: read the live desired-state estate (v2.9.0). */
  gitopsReadLive?: () => import('./gitops/gitOpsService').DesiredEntity[] | Promise<import('./gitops/gitOpsService').DesiredEntity[]>
  /** GitOps: apply one entity to live state (v2.9.0). */
  gitopsApplyEntity?: (action: 'upsert' | 'delete', entity: import('./gitops/gitOpsService').DesiredEntity) => Promise<void>
  /** cloud inventory fetchers (v2.9.0). */
  fetchAwsInstances?: (account: import('./cloud/cloudInventory').CloudAccount) => Promise<unknown>
  fetchGcpInstances?: (account: import('./cloud/cloudInventory').CloudAccount) => Promise<unknown>
  fetchAzureVms?: (account: import('./cloud/cloudInventory').CloudAccount) => Promise<unknown>
  /** settings service (v2.9.x) — used to build the default GitOps live estate. */
  settingsService?: { getSettings?: () => unknown }
  /** called with the background driver handles (otel push timer, on-call tick timer)
   * so the runtime can clear them on shutdown. */
  onBackgroundDrivers?: (drivers: { otelPushTimer?: NodeJS.Timeout; oncallTickTimer?: NodeJS.Timeout }) => void
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
  /** AGT policy engine (v2.7.7): evaluates agent actions against YAML policies. */
  governance: {
    policyEngine: AgtPolicyEngine
  }
  /** Review service (v2.7.8): maker/checker pattern — independently verifies the action model's output. */
  review: {
    service: ReviewService
    /** check if a review should be skipped (no reviewModelId). */
    shouldSkipReview: typeof shouldSkipReview
    /** create a skipped review result. */
    createSkippedReviewResult: typeof createSkippedReviewResult
  }
  /** the plugin system registry (v2.5.0). */
  pluginRegistry: PluginRegistry
  /** Prometheus scrape exporter + OTel push exporter (v2.9.0): RTerm observed by other tools. */
  metricsExport: {
    registry: PrometheusRegistry
    otel: OtelExporter | null
    registryFromHostMetrics: typeof registryFromHostMetrics
    /** rebuild the registry from the metrics ledger's latest points + render text. */
    renderPrometheus: () => string
  }
  /** Built-in encrypted secrets vault (v2.9.0): AES-256-GCM, never in LLM context. */
  secrets: SecretsVault
  /** Incident escalation & on-call paging (v2.9.0). */
  oncall: EscalationService
  /** AI cost attribution + budgets (v2.9.0). */
  cost: CostBudgetService
  /** asciinema-style session recording + replay (v2.9.0). */
  recording: SessionRecorder
  /** GitOps — desired state in Git, drift + reconcile (v2.9.0). */
  gitops: GitOpsService
  /** Playbook/runbook versioning + lint (v2.9.0). */
  playbooks: {
    versioning: PlaybookVersioning
    lint: typeof lintPlaybook
    lintOk: typeof lintOk
  }
  /** Cloud resource inventory (AWS/GCP/Azure) (v2.9.0). */
  cloud: CloudInventory
  /** Live multi-client dashboard hub (v2.9.0): push-based state to web/TUI/mobile. */
  liveDashboard: LiveDashboardHub<import('./dashboard/dashboardService').DashboardState>
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

// --- AGT policy engine (v2.7.7): evaluates agent actions against YAML policies ---
// The policy is loaded lazily on first evaluate() call (createObservability is not async).
const policyEngine = new AgtPolicyEngine({
  loadPolicy: async () => {
    // Default: load from a policy file in the data directory, or use a built-in default.
    const req = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url)
    const fs = req('node:fs') as typeof import('node:fs')
    const path = req('node:path') as typeof import('node:path')
    const policyPath = path.join('.', 'policy.yaml')
    if (fs.existsSync(policyPath)) {
      return parsePolicyYaml(fs.readFileSync(policyPath, 'utf8'))
    }
    // Built-in default policy: allow read-only, deny destructive, escalate prod changes.
    return {
      name: 'rterm-default', version: '1.0', defaultDecision: 'deny' as const,
      rules: [
        { name: 'allow-read', actionPattern: 'read', decision: 'allow' as const },
        { name: 'allow-status', actionPattern: 'status', decision: 'allow' as const },
        { name: 'allow-list', actionPattern: 'list', decision: 'allow' as const },
        { name: 'deny-delete', actionPattern: 'delete', decision: 'deny' as const },
        { name: 'deny-drop', actionPattern: 'drop', decision: 'deny' as const },
        { name: 'deny-format', actionPattern: 'format', decision: 'deny' as const },
        { name: 'escalate-restart-prod', actionPattern: 'restart', targetPattern: 'prod-*', decision: 'escalate' as const },
        { name: 'escalate-patch-prod', actionPattern: 'patch', targetPattern: 'prod-*', decision: 'escalate' as const },
        { name: 'escalate-deploy-prod', actionPattern: 'deploy', targetPattern: 'prod-*', decision: 'escalate' as const },
        { name: 'allow-restart', actionPattern: 'restart', decision: 'allow' as const },
        { name: 'allow-patch', actionPattern: 'patch', decision: 'allow' as const },
        { name: 'allow-deploy', actionPattern: 'deploy', decision: 'allow' as const },
      ],
    }
  },
  agentIdentity: `rterm-agent-v${process.env.GYBACKEND_VERSION ?? '2.7.7'}`,
  sponsoringPrincipal: process.env.USER ?? 'unknown',
})
// Load the policy lazily on first use (fire-and-forget; evaluate() will throw if not loaded yet,
// but the agent will call load() explicitly before evaluating).
void policyEngine.load().catch(() => {})

// --- Review service (v2.7.8): maker/checker pattern ---
// The review model independently verifies the action model's output.
// If no reviewModelId is specified in the profile, reviews are skipped entirely (fast output mode).
const reviewService = new ReviewService({
  runReviewModel: deps.runReviewModel ?? (async (_prompt) => ({
    verdict: 'approved' as const,
    issues: [],
    reasoning: 'no review model configured',
    confidence: 1.0,
  })),
  reviewerId: deps.reviewerId ?? 'review-model',
  reviewMode: deps.reviewMode ?? 'strict',
})

  // --- Plugin system (v2.5.0): discover + auto-integrate custom plugins from plugins/. ---
  const pluginScanRoot = (process.env.GYBACKEND_DATA_DIR ?? './.gybackend-data') + '/plugins'
  // Also scan the bundle's own plugins/ directory (for the rterm-backend npm package,
  // where plugins ship alongside the gybackend binary). The bundle is at bin/gybackend.js,
  // so the plugins are at ../plugins/ relative to the bundle file. We check that the
  // directory actually exists before adding it (in the source/unbundled case it won't).
  const bundlePluginRoot = typeof __filename !== 'undefined'
    ? path.join(path.dirname(__filename), '..', '..', 'plugins')
    : new URL('../../plugins/', import.meta.url).pathname
  const scanRoots = [pluginScanRoot, './plugins']
  try {
    const req = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url)
    const fs = req('node:fs') as typeof import('node:fs')
    if (fs.existsSync(bundlePluginRoot)) scanRoots.push(bundlePluginRoot)
  } catch { /* best-effort */ }
  // Also scan the Electron app's resources/plugins/ directory (for the desktop app,
  // where plugins are shipped as electron-builder extraResources). process.resourcesPath
  // is set by Electron to {app}/Contents/Resources (macOS) or {app}/resources (Windows/Linux).
  try {
    const req = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url)
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

  // --- Prometheus / OTel metrics export (v2.9.0): RTerm observed by other tools ---
  const prometheusRegistry = new PrometheusRegistry({ prefix: 'rterm' })
  const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? process.env.RTERM_OTLP_METRICS_ENDPOINT
  const otelExporter = otelEndpoint
    ? new OtelExporter({
        endpoint: otelEndpoint,
        resourceAttributes: { 'service.name': 'rterm', 'service.version': process.env.GYBACKEND_VERSION ?? 'dev' },
      })
    : null

  // Rebuild the Prometheus registry from the metrics ledger's latest points.
  const renderPrometheus = (): string => {
    const series: Array<{ host: string; metric: string; value: number }> = []
    for (const host of metricsLedger.hosts()) {
      const latest = metricsLedger.latest(host)
      if (!latest) continue
      for (const [k, v] of Object.entries(latest)) {
        if (k === 'host' || k === 'at') continue
        if (typeof v === 'number' && Number.isFinite(v)) series.push({ host, metric: `host_${k}`, value: v })
      }
    }
    const reg = registryFromHostMetrics(series, { prefix: 'rterm', helpPrefix: 'RTerm host metric' })
    return reg.render()
  }

  // --- Secrets vault (v2.9.0): encrypted at rest, never in LLM context ---
  const secretsVault = new SecretsVault({
    masterKey: process.env.RTERM_SECRETS_MASTER_KEY,
    onAudit: (action, key) => {
      try {
        auditLedger.append({
          kind: 'config_change',
          actor: 'secrets-vault',
          target: key,
          summary: `secret ${action}`,
          detail: { action },
        })
      } catch { /* best-effort */ }
    },
  })

  // --- Incident escalation & on-call (v2.9.0) ---
  const escalationService = new EscalationService({ channels: deps.pagingChannels ?? [] })

  // --- AI cost & budgets (v2.9.0): feed from the agent run ledger's usage events ---
  const costBudgetService = new CostBudgetService({ prices: deps.modelPrices })

  // --- Session recording (v2.9.0) ---
  const sessionRecorder = new SessionRecorder({})

  // --- GitOps (v2.9.0): desired state in Git ---
  // Default readLive: build the live estate from saved connections + automation
  // (groups/scripts/playbooks/triggers/templates) so gitops works out of the box.
  const defaultGitopsReadLive = (): DesiredEntity[] => {
    const out: DesiredEntity[] = []
    try {
      const settings = deps.settingsService?.getSettings?.() as { connections?: Record<string, unknown> } | undefined
      const conns = (settings?.connections ?? {}) as Record<string, unknown>
      for (const [kind, list] of Object.entries(conns)) {
        if (!Array.isArray(list)) continue
        for (const c of list as Array<Record<string, unknown>>) {
          const id = c?.id ?? c?.name
          if (id) out.push({ id: `connection:${kind}:${String(id)}`, kind: 'connection', spec: c })
        }
      }
    } catch { /* best-effort */ }
    try {
    const am = deps.automationManager
    const groups = ((am?.listGroups?.() ?? []) as unknown) as Array<Record<string, unknown>>
    for (const g of groups) { const id = g?.id ?? g?.name; if (id) out.push({ id: `group:${String(id)}`, kind: 'group', spec: g }) }
    const scripts = ((am?.listScripts?.() ?? []) as unknown) as Array<Record<string, unknown>>
    for (const s of scripts) { const id = s?.id ?? s?.name; if (id) out.push({ id: `script:${String(id)}`, kind: 'script', spec: s }) }
    const playbooks = ((am?.listPlaybooks?.() ?? []) as unknown) as Array<Record<string, unknown>>
    for (const p of playbooks) { const id = p?.id ?? p?.name; if (id) out.push({ id: `playbook:${String(id)}`, kind: 'playbook', spec: p }) }
    const templates = ((am?.listTemplates?.() ?? []) as unknown) as Array<Record<string, unknown>>
    for (const t of templates) { const id = t?.id ?? t?.name; if (id) out.push({ id: `template:${String(id)}`, kind: 'template', spec: t }) }
    const tasks = ((am?.listScheduledTasks?.() ?? []) as unknown) as Array<Record<string, unknown>>
    for (const t of tasks) { const id = t?.id ?? t?.name; if (id) out.push({ id: `scheduledTask:${String(id)}`, kind: 'scheduledTask', spec: t }) }
    } catch { /* best-effort */ }
    return out
  }
  const gitopsService = new GitOpsService({
    readLive: deps.gitopsReadLive ?? defaultGitopsReadLive,
    applyEntity: deps.gitopsApplyEntity,
  })

  // --- Playbook versioning + lint (v2.9.0) ---
  const playbookVersioning = new PlaybookVersioning({})

  // --- Cloud inventory (v2.9.0): real fetchers via the provider CLIs when no
  // explicit fetcher is injected. Runs the CLI, parses JSON. Best-effort — a
  // missing CLI or missing credentials surfaces as a sync error, not a crash.
const runCliJson = async (bin: string, args: string[]): Promise<unknown> => {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err)
      try { resolve(JSON.parse(stdout)) } catch (e) { reject(e instanceof Error ? e : new Error('invalid JSON')) }
    })
  })
}
const cloudInventory = new CloudInventory({
  fetchAwsInstances: deps.fetchAwsInstances ?? (async () => runCliJson('aws', ['ec2', 'describe-instances', '--output', 'json'])),
  fetchGcpInstances: deps.fetchGcpInstances ?? (async () => runCliJson('gcloud', ['compute', 'instances', 'list', '--format', 'json'])),
  fetchAzureVms: deps.fetchAzureVms ?? (async () => runCliJson('az', ['vm', 'list', '--show-details', '--output', 'json'])),
})

  // --- Live dashboard hub (v2.9.0): push unified state to all clients ---
  const liveDashboardHub = new LiveDashboardHub({
    getState: () => dashboard.state(),
  })

  // --- Feed monitor snapshots into the metrics ledger + behavior (the live data path) ---
  deps.setMonitorPublisher((channel: string, data: unknown) => {
    if (channel !== 'monitor:snapshot' || !data || typeof data !== 'object') return
    const d = data as { terminalId?: string } & Record<string, unknown>
    const host = d.terminalId ? String(d.terminalId) : 'local'
    try {
      metricsLedger.record(host, d as never)
      // push live dashboard updates to subscribers (best-effort, non-blocking)
      void liveDashboardHub.publish().catch(() => {})
    } catch { /* best-effort */ }
  })

  // --- AI cost auto-feed (v2.9.x): mirror agent-run token usage into the cost
  // ledger so spend attribution works without manual costRecord calls. Reads
  // completed runs from the run ledger and records any not-yet-counted usage.
  let lastCostRunId: string | null = null
  const feedCostFromRuns = (): void => {
    try {
      const runs = deps.agentRunLedger?.listRuns?.({ limit: 100 }) ?? []
      for (const r of runs as Array<{ runId: string; status: string; model?: string; promptTokens: number; completionTokens: number }>) {
        if (r.runId === lastCostRunId) break // already fed up to here
        if (!r.model || (r.promptTokens === 0 && r.completionTokens === 0)) continue
        costBudgetService.record({ model: r.model, promptTokens: r.promptTokens, completionTokens: r.completionTokens })
      }
      const newest = (runs as Array<{ runId: string }>)[0]
      if (newest) lastCostRunId = newest.runId
    } catch { /* best-effort */ }
  }
  // Feed on a slow interval (cost is not latency-sensitive) + once at startup.
  const costFeedTimer = setInterval(feedCostFromRuns, 60_000)
  if (typeof costFeedTimer.unref === 'function') costFeedTimer.unref()
  feedCostFromRuns()

  // --- OTel push driver (v2.9.x): push metrics to the collector on an interval
  // when an endpoint is configured. Default 30s; disabled when no exporter.
  let otelPushTimer: NodeJS.Timeout | undefined
  if (otelExporter) {
    const intervalMs = Number(process.env.OTEL_EXPORTER_OTLP_INTERVAL_MS ?? 30_000) || 30_000
    const pushOnce = async () => {
      try {
        // refresh the registry from the ledger before pushing
        renderPrometheus()
        await otelExporter.push(prometheusRegistry)
      } catch { /* best-effort — a collector outage never blocks RTerm */ }
    }
    otelPushTimer = setInterval(() => { void pushOnce() }, intervalMs)
    if (typeof otelPushTimer.unref === 'function') otelPushTimer.unref()
    void pushOnce()
  }

  // --- On-call escalation driver (v2.9.x): advance the escalation clock on an
  // interval so unacked pages escalate automatically (no manual oncallTick).
  const oncallTickTimer = setInterval(() => {
    void escalationService.tick().catch(() => {})
  }, 30_000)
  if (typeof oncallTickTimer.unref === 'function') oncallTickTimer.unref()

  deps.onBackgroundDrivers?.({ otelPushTimer, oncallTickTimer })

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
    governance: { policyEngine },
    review: { service: reviewService, shouldSkipReview, createSkippedReviewResult },
    pluginRegistry,
    metricsExport: {
      registry: prometheusRegistry,
      otel: otelExporter,
      registryFromHostMetrics,
      renderPrometheus,
    },
    secrets: secretsVault,
    oncall: escalationService,
    cost: costBudgetService,
    recording: sessionRecorder,
    gitops: gitopsService,
    playbooks: { versioning: playbookVersioning, lint: lintPlaybook, lintOk },
    cloud: cloudInventory,
    liveDashboard: liveDashboardHub,
  }
}
