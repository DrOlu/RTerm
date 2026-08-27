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
import { LlmTraceRecorder } from './observability/llmTrace'
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
  /** model price table for AI cost attribution (v2.9.0). When omitted, the
   * persisted settings.cost.modelPrices block is used (and re-read on refresh). */
  modelPrices?: import('./cost/costBudgetService').CostBudgetDeps['prices']
  /** programmatic budget override (v2.9.x). When omitted, persisted
   * settings.cost.budgets are registered (and re-read on refresh). */
  costBudgets?: Array<import('./cost/costBudgetService').Budget>
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
  /** v3.2.13: OpenLLMetry-style LLM call tracing into the APM ledger. */
  llmTrace: LlmTraceRecorder
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
  /** Re-read prices + budgets from settings (call on settings change). */
  refreshCost: () => void
  /** Rebuild alert channels from settings.alerts + vault (call on settings change). */
  refreshAlertChannels: () => void
  /** Rebuild on-call paging channels from settings.oncall + vault (call on settings change). */
  refreshOncallChannels: () => void
  /** Re-register cloud-inventory accounts from settings.cloud (call on settings change). */
  refreshCloudAccounts: () => void
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

interface SmtpConfig {
  host: string
  port: number
  secure?: boolean
  auth?: { user: string; pass: string }
}

/** Read one SMTP reply (until a line whose 4th char is a space, per RFC 5321). */
function makeLineReader(onChunk: (cb: (buf: Buffer) => void) => void): () => Promise<string> {
  let buffer = ''
  const waiters: Array<(s: string) => void> = []
  onChunk((chunk) => {
    buffer += chunk.toString('utf8')
    flush()
  })
  const complete = (buf: string): boolean => /^\d{3} /m.test(buf)
  function flush(): void {
    if (!waiters.length) return
    if (!complete(buffer)) return
    const out = buffer
    buffer = ''
    const w = waiters.shift()
    w?.(out)
  }
  return () => new Promise<string>((resolve) => {
    if (complete(buffer)) {
      const out = buffer
      buffer = ''
      resolve(out)
      return
    }
    waiters.push(resolve)
  })
}

/**
 * Minimal, dependency-free SMTP sender (EHLO → [STARTTLS] → [AUTH LOGIN] →
 * MAIL FROM → RCPT TO → DATA → QUIT) over Node's built-in net/tls. Backend has
 * no mail dependency, so this keeps alert email working out of the box with no
 * placeholder. Supports implicit TLS (secure, port 465) and STARTTLS (587).
 */
export async function sendSmtpMail(
  cfg: SmtpConfig,
  mail: { from: string; to: string[]; subject: string; text: string; html: string },
): Promise<string> {
  const net = await import('node:net')
  const tls = await import('node:tls')

  const boundary = `----rterm-${Date.now().toString(36)}`
  const addr = (a: string) => a.replace(/^.*<(.+)>.*$/, '$1').trim()
  const dataLines = [
    `From: ${mail.from}`,
    `To: ${mail.to.join(', ')}`,
    `Subject: ${mail.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    mail.text,
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    ``,
    mail.html,
    `--${boundary}--`,
  ].join('\r\n')

  const expect = (reply: string, codes: number[], step: string): void => {
    const code = parseInt(reply.slice(0, 3), 10)
    if (!codes.includes(code)) throw new Error(`smtp ${step} failed: ${reply.trim().slice(0, 200)}`)
  }

  // Open the control channel (implicit TLS for secure, plain + optional STARTTLS otherwise).
  const dataCbs: Array<(chunk: Buffer) => void> = []
  const attach = (socket: import('node:net').Socket | import('node:tls').TLSSocket): void => {
    socket.on('data', (chunk) => { for (const cb of dataCbs) cb(chunk) })
  }
  let socket: import('node:net').Socket | import('node:tls').TLSSocket

  if (cfg.secure) {
    socket = await new Promise<import('node:tls').TLSSocket>((resolve, reject) => {
      const s = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      s.once('secureConnect', () => resolve(s))
      s.once('error', reject)
    })
  } else {
    socket = await new Promise<import('node:net').Socket>((resolve, reject) => {
      const s = net.connect({ host: cfg.host, port: cfg.port })
      s.once('connect', () => resolve(s))
      s.once('error', reject)
    })
  }
  attach(socket)
  let read = makeLineReader((cb) => dataCbs.push(cb))

  try {
    expect(await read(), [220], 'greeting')
    socket.write(`EHLO rterm.local\r\n`)
    let ehlo = await read()
    expect(ehlo, [250], 'EHLO')

    if (!cfg.secure && /STARTTLS/i.test(ehlo)) {
      socket.write(`STARTTLS\r\n`)
      expect(await read(), [220], 'STARTTLS')
      // Upgrade the same connection to TLS and re-read with a fresh buffer.
      const plain = socket as import('node:net').Socket
      plain.removeAllListeners('data')
      dataCbs.length = 0
      socket = await new Promise<import('node:tls').TLSSocket>((resolve, reject) => {
        const ts = tls.connect({ socket: plain, servername: cfg.host })
        ts.once('secureConnect', () => resolve(ts))
        ts.once('error', reject)
      })
      attach(socket)
      read = makeLineReader((cb) => dataCbs.push(cb))
      socket.write(`EHLO rterm.local\r\n`)
      ehlo = await read()
      expect(ehlo, [250], 'EHLO (post-TLS)')
    }

    if (cfg.auth) {
      socket.write(`AUTH LOGIN\r\n`)
      expect(await read(), [334], 'AUTH LOGIN')
      socket.write(`${Buffer.from(cfg.auth.user, 'utf8').toString('base64')}\r\n`)
      expect(await read(), [334], 'AUTH user')
      socket.write(`${Buffer.from(cfg.auth.pass, 'utf8').toString('base64')}\r\n`)
      expect(await read(), [235], 'AUTH pass')
    }

    socket.write(`MAIL FROM:<${addr(mail.from)}>\r\n`)
    expect(await read(), [250], 'MAIL FROM')
    for (const rcpt of mail.to) {
      socket.write(`RCPT TO:<${addr(rcpt)}>\r\n`)
      expect(await read(), [250, 251], 'RCPT TO')
    }
    socket.write(`DATA\r\n`)
    expect(await read(), [354], 'DATA')
    socket.write(`${dataLines}\r\n.\r\n`)
    const sent = await read()
    expect(sent, [250], 'message body')
    socket.write(`QUIT\r\n`)
    return 'smtp 250 sent'
  } finally {
    try { socket.end() } catch { /* best-effort */ }
  }
}

export function createObservability(deps: ObservabilityDeps): Observability {
  const log = deps.onLog ?? (() => {})

  // --- SRE core ---
  const metricsLedger = new MetricsLedger({})
  const goldenSignals = new GoldenSignals({ ledger: metricsLedger })
  const incidentLedger = new IncidentLedger({})
  // Alert channels are resolved from settings.alerts + the secrets vault at send
  // time. AlertService reads deps.channels lazily on every fire(), so we hand it
  // a live array we mutate in refreshAlertChannels() — channels update without a
  // restart. deps.alertChannels (when injected) is a programmatic override.
  const liveAlertChannels: AlertChannel[] = Array.isArray(deps.alertChannels) ? [...deps.alertChannels] : []
  const alertService = new AlertService({ channels: liveAlertChannels })
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
  // v3.2.13: OpenLLMetry-style LLM tracing — every model call becomes a span
  // in the APM ledger (grouped per agent run), optionally forwarded OTLP.
  const llmTrace = new LlmTraceRecorder()
  llmTrace.setSpanLedger(spanLedger)
  const rumLedger = new RumLedger({})
  const infraMonitor = new InfraMonitor({})
  const etwService = new EtwService({})

  // --- Dashboard ---
  const dashboard = new DashboardService({
    metricsLedger, goldenSignals, sloService, uptimeWatchdog, incidentLedger,
    spanLedger, rumLedger, infraMonitor,
    getExtras: () => {
      const am = deps.automationManager
      const playbooks = am.listPlaybooks().map((p) => ({
        id: p.id,
        name: p.name,
        lastRunAt: p.lastRunAt,
        lastRunOk: p.lastRunOk,
      }))
      const scheduledTasks = am.listScheduledTasks().map((t) => ({
        id: t.id,
        name: t.name,
        enabled: t.enabled,
        lastRunAt: t.lastRunAt,
      }))
      const triggers = am.listTriggers().map((t) => ({
        id: t.id,
        name: t.name,
        enabled: t.enabled,
        kind: t.kind,
        lastFiredAt: t.lastFiredAt,
        fireCount: t.fireCount,
      }))
      const agentRuns = deps.agentRunLedger.listRuns({ limit: 12 }).map((r) => ({
        runId: r.runId,
        sessionId: r.sessionId,
        status: r.status,
        error: r.error,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        inputPreview: r.inputPreview,
      }))
      return { playbooks, scheduledTasks, triggers, agentRuns }
    },
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
  // In the standalone bundle (bin/gybackend.cjs), dirname = .../neuralos/bin/,
  // so '..' = .../neuralos/ (package root), and 'plugins' = .../neuralos/plugins/.
  // In the source tree (packages/backend/src/services/observability.ts), dirname is
  // deeper, so '../..' is needed — but we guard with existsSync so the wrong one is skipped.
  const bundlePluginRoot = typeof __filename !== 'undefined'
    ? path.join(path.dirname(__filename), '..', 'plugins')
    : new URL('../plugins/', import.meta.url).pathname
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
      // Real child_process spawn for sidecar daemons (web-intel's wigolo serve).
      (command, args, opts) => {
        // Lazy ESM-safe require so this only loads when a plugin actually spawns.
        const req = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url)
        const cp = req('node:child_process') as typeof import('node:child_process')
        return cp.spawn(command, args, {
          env: opts?.env as NodeJS.ProcessEnv | undefined,
          detached: opts?.detached ?? false,
          stdio: (opts?.stdio as never) ?? 'ignore',
        })
      },
      // Live settings snapshot for plugins that read config blocks (webIntel, agentspan, …).
      () => (deps.settingsService?.getSettings?.() as Record<string, unknown>) ?? {},
    ),
    onLog: deps.onLog,
  })
  // Plugin loading is now owned by startGyBackend (which awaits reload() and
  // wires the tools into the agent). The fire-and-forget reload here was racing
  // with the awaited reload in startGyBackend, causing the wiring to hang.
  // void pluginRegistry.reload().catch(() => {})

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
  // v3.2.13 fix: returns the freshly-built registry so BOTH consumers (the
  // Prometheus scrape renderer and the OTel pusher) read the same data.
  // Previously this only returned rendered text while the OTel pusher kept
  // pushing the original empty singleton — pushed payloads were always empty
  // even when `observability:metricsPrometheus` showed host metrics.
  const buildHostMetricsRegistry = (): PrometheusRegistry => {
    const series: Array<{ host: string; metric: string; value: number }> = []
    for (const host of metricsLedger.hosts()) {
      const latest = metricsLedger.latest(host)
      if (!latest) continue
      for (const [k, v] of Object.entries(latest)) {
        if (k === 'host' || k === 'at') continue
        if (typeof v === 'number' && Number.isFinite(v)) series.push({ host, metric: `host_${k}`, value: v })
      }
    }
    return registryFromHostMetrics(series, { prefix: 'rterm', helpPrefix: 'RTerm host metric' })
  }
  const renderPrometheus = (): string => buildHostMetricsRegistry().render()

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
  // Paging channels are built from settings.oncall + the vault (secretRef) and
  // hot-swapped via setChannels() on refresh — no restart. deps.pagingChannels
  // (when injected) is a programmatic override.
  const escalationService = new EscalationService({ channels: deps.pagingChannels ?? [] })

  // --- Alert channels (v2.9.x): build live AlertChannels from settings.alerts,
  // resolving each channel's secret from the vault at send time (secretRef).
  // The array is mutated in place so AlertService (which reads it on fire())
  // picks up channel edits without a restart. Skipped when deps.alertChannels is
  // injected (programmatic override).
const httpFetch: import('./notify/notifyService').HttpFetchFn = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body })
  return { ok: res.ok, status: res.status, text: () => res.text() }
}
const resolveAlertSecret = (ref: string | undefined): string | undefined => {
    if (!ref) return undefined
    try {
      if (!secretsVault.unlocked()) return undefined
      return secretsVault.has(ref) ? secretsVault.get(ref) : undefined
    } catch {
      return undefined
    }
  }
  const readAlertSettings = (): Array<import('../types').AlertChannelEntry> => {
    try {
      const s = deps.settingsService?.getSettings?.() as { alerts?: { channels?: Array<import('../types').AlertChannelEntry> } } | undefined
      return Array.isArray(s?.alerts?.channels) ? (s!.alerts!.channels as Array<import('../types').AlertChannelEntry>) : []
    } catch {
      return []
    }
  }
  const refreshAlertChannels = (): void => {
    if (Array.isArray(deps.alertChannels)) return // programmatic override wins
    try {
      const built: AlertChannel[] = []
      for (const ch of readAlertSettings()) {
        if (!ch.enabled) continue
        const minSeverity = ch.minSeverity
        if (ch.type === 'slack' || ch.type === 'teams') {
          const webhookUrl = resolveAlertSecret(ch.secretRef)
          if (!webhookUrl) { log(`[alerts] channel ${ch.id} skipped — secret "${ch.secretRef}" unavailable (vault locked or missing)`) ; continue }
          built.push(ch.type === 'slack'
            ? slackChannel({ webhookUrl, ...(minSeverity ? { minSeverity } : {}) }, httpFetch)
            : teamsChannel({ webhookUrl, ...(minSeverity ? { minSeverity } : {}) }, httpFetch))
        } else if (ch.type === 'telegram') {
          const botToken = resolveAlertSecret(ch.secretRef)
          if (!botToken || !ch.chatId) { log(`[alerts] telegram channel ${ch.id} skipped — bot token or chatId missing`) ; continue }
          built.push(telegramChannel({ botToken, chatId: ch.chatId, ...(minSeverity ? { minSeverity } : {}) }, httpFetch))
        } else if (ch.type === 'smtp') {
          if (!ch.smtp) { log(`[alerts] smtp channel ${ch.id} skipped — no smtp config`) ; continue }
          const cfg = ch.smtp
          const password = resolveAlertSecret(ch.secretRef)
          const smtpFn: import('./notify/notifyService').SmtpSendFn = async (mail) =>
            sendSmtpMail({
              host: cfg.host,
              port: cfg.port,
              secure: cfg.secure === true,
              ...(cfg.user ? { auth: { user: cfg.user, pass: password ?? '' } } : {}),
            }, mail)
          built.push(smtpChannel({ from: cfg.from, to: cfg.to, name: ch.name, ...(minSeverity ? { minSeverity } : {}) }, smtpFn))
        }
      }
    liveAlertChannels.splice(0, liveAlertChannels.length, ...built)
    log(`[alerts] ${built.length} channel(s) active`)
  } catch { /* best-effort */ }
}
refreshAlertChannels()

// --- On-call paging channels (v2.9.x): build live PageChannels from
// settings.oncall.pagingChannels + the vault. A page targets a channel by name;
// send(target, page, level) formats + delivers via the matching transport.
const readOncallSettings = (): Array<import('../types').PagingChannelEntry> => {
  try {
    const s = deps.settingsService?.getSettings?.() as { oncall?: { pagingChannels?: Array<import('../types').PagingChannelEntry> } } | undefined
    return Array.isArray(s?.oncall?.pagingChannels) ? (s!.oncall!.pagingChannels as Array<import('../types').PagingChannelEntry>) : []
  } catch {
    return []
  }
}
const SEV_RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 }
const pageSeverityRank = (sev: string): number => SEV_RANK[sev?.toLowerCase?.() ?? ''] ?? 0
const buildPageText = (target: import('./oncall/escalationService').OnCallTarget, page: import('./oncall/escalationService').Page, level: number): string =>
  [`🔥 *${page.title}*`, ``, `*Severity:* ${page.severity.toUpperCase()}`, `*Incident:* ${page.incidentId}`, `*Level:* ${level + 1}`, `*Target:* ${target.id}`, ``, `_RTerm On-Call_`].join('\n')
const refreshOncallChannels = (): void => {
  if (Array.isArray(deps.pagingChannels)) return // programmatic override wins
  try {
    const built: Array<import('./oncall/escalationService').PageChannel> = []
    for (const ch of readOncallSettings()) {
      if (!ch.enabled) continue
      const minRank = ch.minSeverity ? pageSeverityRank(ch.minSeverity) : 0
      const gate = (page: import('./oncall/escalationService').Page): boolean => pageSeverityRank(page.severity) >= minRank
      if (ch.type === 'slack' || ch.type === 'teams' || ch.type === 'webhook') {
        const url = ch.type === 'webhook' ? (ch.webhookUrl ?? resolveAlertSecret(ch.secretRef)) : resolveAlertSecret(ch.secretRef)
        if (!url) { log(`[oncall] channel ${ch.id} skipped — url/secret unavailable`); continue }
        built.push({
          name: ch.name,
          send: async (target, page, level) => {
            if (!gate(page)) return 'skipped: below min severity'
            const text = buildPageText(target, page, level)
            const body = ch.type === 'teams'
              ? JSON.stringify({ '@type': 'MessageCard', '@context': 'https://schema.org/extensions', summary: page.title, text })
              : ch.type === 'slack'
                ? JSON.stringify({ text })
                : JSON.stringify({ kind: 'rterm.page', target: target.id, level, page: { id: page.id, incidentId: page.incidentId, title: page.title, severity: page.severity }, text })
            const res = await httpFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
            if (!res.ok) throw new Error(`${ch.type} page ${res.status}: ${await res.text()}`)
            return `${ch.type} ${res.status}`
          },
        })
      } else if (ch.type === 'telegram') {
        const botToken = resolveAlertSecret(ch.secretRef)
        if (!botToken) { log(`[oncall] telegram channel ${ch.id} skipped — bot token missing`); continue }
        built.push({
          name: ch.name,
          send: async (target, page, level) => {
            if (!gate(page)) return 'skipped: below min severity'
            const chatId = target.id || ch.chatId
            if (!chatId) throw new Error('telegram page: no chat id (target.id or channel chatId)')
            const text = buildPageText(target, page, level)
            const res = await httpFetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
            })
            if (!res.ok) throw new Error(`telegram page ${res.status}: ${await res.text()}`)
            return `telegram ${res.status}`
          },
        })
      } else if (ch.type === 'smtp') {
        if (!ch.smtp) { log(`[oncall] smtp channel ${ch.id} skipped — no smtp config`); continue }
        const cfg = ch.smtp
        const password = resolveAlertSecret(ch.secretRef)
        built.push({
          name: ch.name,
          send: async (target, page, level) => {
            if (!gate(page)) return 'skipped: below min severity'
            const text = buildPageText(target, page, level).replace(/\*/g, '')
            const to = target.id ? [target.id, ...cfg.to] : cfg.to
            return sendSmtpMail(
              { host: cfg.host, port: cfg.port, secure: cfg.secure === true, ...(cfg.user ? { auth: { user: cfg.user, pass: password ?? '' } } : {}) },
              { from: cfg.from, to, subject: `[PAGE/${page.severity.toUpperCase()}] ${page.title}`, text, html: `<pre>${text}</pre>` },
            )
          },
        })
      }
    }
    escalationService.setChannels(built)
    log(`[oncall] ${built.length} paging channel(s) active`)
  } catch { /* best-effort */ }
}
refreshOncallChannels()

  // --- AI cost & budgets (v2.9.0): feed from the agent run ledger's usage events ---
  // Price table + budgets are persisted in settings.cost so they survive restarts.
  // deps.modelPrices (when injected) still wins for programmatic/test wiring;
  // otherwise we read the persisted settings block.
  const readCostSettings = (): { modelPrices: Record<string, import('./cost/costBudgetService').ModelPrice>; budgets: Array<import('./cost/costBudgetService').Budget> } => {
    try {
      const s = deps.settingsService?.getSettings?.() as { cost?: { modelPrices?: Record<string, import('./cost/costBudgetService').ModelPrice>; budgets?: Array<import('./cost/costBudgetService').Budget> } } | undefined
      return {
        modelPrices: (s?.cost?.modelPrices ?? {}) as Record<string, import('./cost/costBudgetService').ModelPrice>,
        budgets: Array.isArray(s?.cost?.budgets) ? (s!.cost!.budgets as Array<import('./cost/costBudgetService').Budget>) : [],
      }
    } catch {
      return { modelPrices: {}, budgets: [] }
    }
  }
  const initialCost = readCostSettings()
  const costBudgetService = new CostBudgetService({ prices: deps.modelPrices ?? initialCost.modelPrices })
  const readBudgets = (): Array<import('./cost/costBudgetService').Budget> => {
    if (Array.isArray(deps.costBudgets)) return deps.costBudgets
    return readCostSettings().budgets
  }
  const syncCostBudgets = (): void => {
    try {
      costBudgetService.clearBudgets()
      for (const b of readBudgets()) costBudgetService.setBudget(b)
    } catch { /* best-effort */ }
  }
  syncCostBudgets()

  /** Live re-sync prices + budgets from settings (called on settings change).
   * Prices only refresh from settings when no programmatic price table was
   * injected (deps.modelPrices is an explicit override). */
  const refreshCost = (): void => {
    try {
      if (deps.modelPrices === undefined) {
        costBudgetService.setPrices(readCostSettings().modelPrices)
      }
      syncCostBudgets()
    } catch { /* best-effort */ }
  }

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
  // Fetchers are account-aware: they honor the account's region scope and inject
  // a vault-resolved credential env (secretRef → KEY=VAL lines) for that call.
const runCliJson = async (bin: string, args: string[], env?: Record<string, string>): Promise<unknown> => {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env }, (err, stdout) => {
      if (err) return reject(err)
      try { resolve(JSON.parse(stdout)) } catch (e) { reject(e instanceof Error ? e : new Error('invalid JSON')) }
    })
  })
}
/** Parse a vault credential blob ("KEY=VAL" per line) into an env map. */
const parseCredEnv = (blob: string | undefined): Record<string, string> | undefined => {
  if (!blob) return undefined
  const out: Record<string, string> = {}
  for (const line of blob.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].trim()
  }
  return Object.keys(out).length > 0 ? out : undefined
}
const cloudCredEnvFor = (entry: import('../types').CloudAccountEntry): Record<string, string> | undefined =>
  parseCredEnv(resolveAlertSecret(entry.secretRef))
const cloudInventory = new CloudInventory({
  fetchAwsInstances: deps.fetchAwsInstances ?? (async (account) => {
    const entry = readCloudSettings().find((a) => a.provider === 'aws' && a.accountId === account.accountId)
    const region = entry?.region
    const args = ['ec2', 'describe-instances', '--output', 'json', ...(region ? ['--region', region] : [])]
    return runCliJson('aws', args, entry ? cloudCredEnvFor(entry) : undefined)
  }),
  fetchGcpInstances: deps.fetchGcpInstances ?? (async (account) => {
    const entry = readCloudSettings().find((a) => a.provider === 'gcp' && a.accountId === account.accountId)
    const args = ['compute', 'instances', 'list', '--format', 'json', '--project', account.accountId, ...(entry?.region ? ['--filter', `zone~^${entry.region}`] : [])]
    return runCliJson('gcloud', args, entry ? cloudCredEnvFor(entry) : undefined)
  }),
  fetchAzureVms: deps.fetchAzureVms ?? (async (account) => {
    const entry = readCloudSettings().find((a) => a.provider === 'azure' && a.accountId === account.accountId)
    const args = ['vm', 'list', '--show-details', '--output', 'json', '--subscription', account.accountId]
    return runCliJson('az', args, entry ? cloudCredEnvFor(entry) : undefined)
  }),
})
/** Register the settings.cloud.accounts (enabled ones) into the inventory. */
function readCloudSettings(): Array<import('../types').CloudAccountEntry> {
  try {
    const s = deps.settingsService?.getSettings?.() as { cloud?: { accounts?: Array<import('../types').CloudAccountEntry> } } | undefined
    return Array.isArray(s?.cloud?.accounts) ? (s!.cloud!.accounts as Array<import('../types').CloudAccountEntry>) : []
  } catch {
    return []
  }
}
const refreshCloudAccounts = (): void => {
  try {
    const accounts = readCloudSettings()
      .filter((a) => a.enabled)
      .map((a) => ({ provider: a.provider, accountId: a.accountId, ...(a.name ? { alias: a.name } : {}) }))
    cloudInventory.setAccounts(accounts)
    log(`[cloud] ${accounts.length} account(s) registered`)
  } catch { /* best-effort */ }
}
refreshCloudAccounts()

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
        // v3.2.13 fix: push the freshly-built registry (host metrics ledger),
        // not the empty boot-time singleton.
        await otelExporter.push(buildHostMetricsRegistry())
      } catch { /* best-effort — a collector outage never blocks RTerm */ }
    }
    otelPushTimer = setInterval(() => { void pushOnce() }, intervalMs)
    if (typeof otelPushTimer.unref === 'function') otelPushTimer.unref()
    void pushOnce()
  }

  // --- LLM trace forwarding (v3.2.13): when an OTLP endpoint is configured,
  // forward LLM spans (OpenLLMetry-style gen_ai attributes) to it as well.
  // Fire-and-forget POST per batch; failures never affect the agent.
  if (otelEndpoint) {
    llmTrace.setOtlpTraceExporter((spans) => {
      void fetch(otelEndpoint.replace(/\/v1\/metrics$/, '/v1/traces'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: {
                attributes: [
                  { key: 'service.name', value: { stringValue: 'rterm-agent' } },
                  { key: 'service.version', value: { stringValue: process.env.GYBACKEND_VERSION ?? 'dev' } },
                ],
              },
              scopeSpans: [{ spans }],
            },
          ],
        }),
      }).catch(() => { /* tracing must never break the agent */ })
    })
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
    llmTrace,
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
    refreshCost,
    refreshAlertChannels,
    refreshOncallChannels,
    refreshCloudAccounts,
    recording: sessionRecorder,
    gitops: gitopsService,
    playbooks: { versioning: playbookVersioning, lint: lintPlaybook, lintOk },
    cloud: cloudInventory,
    liveDashboard: liveDashboardHub,
  }
}
