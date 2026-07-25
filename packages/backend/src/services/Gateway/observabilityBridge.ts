/**
 * observabilityBridge — surfaces the 9 v2.9.x observability capabilities as
 * WebSocket RPC methods on the gateway. One cohesive bridge (mirroring the
 * other *Bridge objects in WebSocketGatewayAdapter) that wraps the services
 * created by createObservability and exposes them to the app, the agent, and
 * any RPC client.
 *
 * All methods are safe-by-default: read methods return structured state;
 * write methods validate + delegate to the underlying pure module. Secrets are
 * NEVER returned in plaintext — only metadata.
 */

import type { Observability } from '../observability'

interface KubectlPodContainerStatus { ready?: boolean; restartCount?: number }
interface KubectlPodItem { metadata?: { name?: string; namespace?: string }; status?: { phase?: string; containerStatuses?: KubectlPodContainerStatus[] } }
interface KubectlPodList { items?: KubectlPodItem[] }

export interface ObservabilityBridgeDeps {
  observability: () => Observability | null
  /** optional TerminalService — enables live recording capture (start/stop route
   * through it so terminal output feeds the recording). */
  terminalService?: () => import('../TerminalService').TerminalService | null
}

function requireObs(deps: ObservabilityBridgeDeps): Observability {
  const o = deps.observability()
  if (!o) throw new Error('observability is not available on this runtime')
  return o
}

export function createObservabilityBridge(deps: ObservabilityBridgeDeps) {
  return {
    // ── metrics / prometheus / otel ─────────────────────────────────────────
    /** Prometheus exposition text for all host metrics. */
    metricsPrometheus: async () => requireObs(deps).metricsExport.renderPrometheus(),
    /** dashboard state (unified). */
    dashboardState: async () => requireObs(deps).dashboard.state(),
    /** dashboard summary line. */
    dashboardSummary: async () => requireObs(deps).dashboard.summary(),

    // ── secrets vault (metadata only — never values) ────────────────────────
    secretsList: async (params: { labelKey?: string; labelValue?: string }) =>
      requireObs(deps).secrets.list(params),
    secretsSet: async (params: { key: string; value: string; labels?: Record<string, string> }) => {
      const v = requireObs(deps).secrets
      v.set(params.key, params.value, params.labels)
      return { ok: true, key: params.key }
    },
    secretsDelete: async (params: { key: string }) => ({ deleted: requireObs(deps).secrets.delete(params.key) }),
    secretsHas: async (params: { key: string }) => ({ exists: requireObs(deps).secrets.has(params.key) }),

    // ── on-call / escalation ────────────────────────────────────────────────
    oncallListPolicies: async () => requireObs(deps).oncall.listPolicies(),
    oncallRegisterPolicy: async (params: Parameters<Observability['oncall']['registerPolicy']>[0]) => {
      requireObs(deps).oncall.registerPolicy(params)
      return { ok: true, id: params.id }
    },
    oncallOpenPages: async () => requireObs(deps).oncall.openPages(),
    oncallPage: async (params: { incidentId: string; policyId: string; title: string; severity: string }) =>
      requireObs(deps).oncall.page(params),
    oncallAck: async (params: { pageId: string; by: string }) => requireObs(deps).oncall.acknowledge(params.pageId, params.by),
    oncallResolve: async (params: { pageId: string }) => requireObs(deps).oncall.resolve(params.pageId),
    oncallTick: async () => requireObs(deps).oncall.tick(),

    // ── AI cost & budgets ───────────────────────────────────────────────────
    costSummary: async (params: { period?: 'daily' | 'monthly'; model?: string; profileId?: string }) =>
      requireObs(deps).cost.summarize(params),
    costRecord: async (params: { model: string; promptTokens: number; completionTokens: number; profileId?: string }) => ({
      usd: requireObs(deps).cost.record(params),
    }),
    costCheck: async (params: { model?: string; profileId?: string }) => requireObs(deps).cost.check(params),
    costListBudgets: async () => requireObs(deps).cost.listBudgets(),
    costSetBudget: async (params: Parameters<Observability['cost']['setBudget']>[0]) => {
      requireObs(deps).cost.setBudget(params)
      return { ok: true, id: params.id }
    },
    costRemoveBudget: async (params: { id: string }) => ({ removed: requireObs(deps).cost.removeBudget(params.id) }),

    // ── session recording ───────────────────────────────────────────────────
    recordingList: async () => requireObs(deps).recording.list(),
    recordingStart: async (params: { terminalId: string; width?: number; height?: number; title?: string }) => {
      // Route through TerminalService when available so live output feeds the recording.
      const ts = deps.terminalService?.()
      if (ts) return { recordingId: ts.startRecording(params.terminalId, params) }
      return { recordingId: requireObs(deps).recording.start(params.terminalId, params) }
    },
    recordingStop: async (params: { recordingId: string }) => requireObs(deps).recording.stop(params.recordingId),
    recordingStopTerminal: async (params: { terminalId: string }) => {
      const ts = deps.terminalService?.()
      const id = ts?.stopRecording(params.terminalId)
      return { recordingId: id, stopped: id !== null && id !== undefined }
    },
    recordingReplay: async (params: { recordingId: string; fromSec?: number; durationSec?: number }) =>
      requireObs(deps).recording.replay(params.recordingId, params),
    recordingExportCast: async (params: { recordingId: string }) => requireObs(deps).recording.exportCast(params.recordingId),
    recordingDelete: async (params: { recordingId: string }) => ({ deleted: requireObs(deps).recording.delete(params.recordingId) }),

    // ── gitops ──────────────────────────────────────────────────────────────
    gitopsExport: async () => requireObs(deps).gitops.exportLive(),
    gitopsDrift: async (params: { manifest: Parameters<Observability['gitops']['drift']>[0] }) =>
      requireObs(deps).gitops.drift(params.manifest),
    gitopsInSync: async (params: { manifest: Parameters<Observability['gitops']['inSync']>[0] }) => ({
      inSync: await requireObs(deps).gitops.inSync(params.manifest),
    }),
    gitopsReconcile: async (params: { manifest: Parameters<Observability['gitops']['reconcile']>[0]; deleteRemoved?: boolean }) =>
      requireObs(deps).gitops.reconcile(params.manifest, { deleteRemoved: params.deleteRemoved }),

    // ── playbook versioning + lint ──────────────────────────────────────────
    playbookLint: async (params: { def: Parameters<Observability['playbooks']['lint']>[0] }) =>
      requireObs(deps).playbooks.lint(params.def),
    playbookHistory: async (params: { playbookId: string }) =>
      requireObs(deps).playbooks.versioning.history(params.playbookId),
    playbookSave: async (params: { playbookId: string; def: Parameters<Observability['playbooks']['versioning']['save']>[1]; comment?: string }) =>
      requireObs(deps).playbooks.versioning.save(params.playbookId, params.def, params.comment),
    playbookRollback: async (params: { playbookId: string; version: number; comment?: string }) =>
      requireObs(deps).playbooks.versioning.rollback(params.playbookId, params.version, params.comment),
    playbookDiff: async (params: { playbookId: string; a: number; b: number }) =>
      requireObs(deps).playbooks.versioning.diff(params.playbookId, params.a, params.b),

    // ── cloud inventory ─────────────────────────────────────────────────────
    cloudSummary: async () => requireObs(deps).cloud.summary(),
    cloudQuery: async (params: Parameters<Observability['cloud']['query']>[0]) => requireObs(deps).cloud.query(params),
    cloudSync: async () => requireObs(deps).cloud.sync(),
    cloudAddAccount: async (params: Parameters<Observability['cloud']['addAccount']>[0]) => {
      requireObs(deps).cloud.addAccount(params)
      return { ok: true }
    },

    // ── APM (OTLP span ingestion) ───────────────────────────────────────────
    apmIngestSpans: async (params: { payload: unknown; defaultService?: string }) => {
      const { ingestOtlp } = await import('../apm/spanLedger')
      const count = ingestOtlp(requireObs(deps).spanLedger, params.payload, params.defaultService)
      return { ingested: count }
    },
    apmSummary: async () => ({
      spans: requireObs(deps).spanLedger.size(),
      traces: requireObs(deps).spanLedger.traceIds().length,
      byService: requireObs(deps).spanLedger.serviceStats(),
    }),

    // ── DEM (RUM beacon ingestion) ──────────────────────────────────────────
    demIngestBeacon: async (params: { payload: unknown }) => {
      const s = requireObs(deps).rumLedger.ingestBeacon(params.payload)
      return { ingested: s !== undefined, id: s?.id }
    },
    demSummary: async () => ({
      sessions: requireObs(deps).rumLedger.size(),
      byPage: requireObs(deps).rumLedger.pageStats(),
    }),

    // ── Infra (k8s collect) ─────────────────────────────────────────────────
    infraCollect: async (params: { context?: string; kubectlJson?: unknown; execKubectl?: () => Promise<unknown> }) => {
      const { parseKubectlPods } = await import('../infra/infraMonitor')
      const context = params.context ?? 'default'
      let podsPayload = params.kubectlJson
      if (podsPayload === undefined) {
        if (!params.execKubectl) throw new Error('infraCollect needs kubectlJson or an injected execKubectl')
        podsPayload = await params.execKubectl()
      }
      const text = typeof podsPayload === 'string' ? podsPayload : JSON.stringify(podsPayload)
      // parseKubectlPods reads the kubectl text table (NAMESPACE NAME READY STATUS RESTARTS AGE).
      // If a JSON object is passed instead, render it to that table shape first.
      let pods = parseKubectlPods(text)
      if (pods.length === 0 && typeof podsPayload === 'object' && podsPayload !== null) {
        const items = (podsPayload as KubectlPodList).items ?? []
        const table = ['NAMESPACE NAME READY STATUS RESTARTS AGE', ...items.map((it) => {
          const ns = it.metadata?.namespace ?? 'default'
          const name = it.metadata?.name ?? 'pod'
          const cs = it.status?.containerStatuses ?? []
          const ready = `${cs.filter((c) => c.ready).length}/${cs.length || 1}`
          const status = it.status?.phase ?? 'Unknown'
          const restarts = String(cs.reduce((s, c) => s + (c.restartCount ?? 0), 0))
          return `${ns} ${name} ${ready} ${status} ${restarts} 1d`
        })].join('\n')
        pods = parseKubectlPods(table)
      }
      const health = requireObs(deps).infraMonitor.recordCluster(context, pods, [])
      return { context, pods: pods.length, notReady: health.notReadyPods, crashLoop: health.crashLoopPods }
    },
    infraClusters: async () => requireObs(deps).infraMonitor.clusters_(),
    infraUnhealthy: async () => requireObs(deps).infraMonitor.unhealthyInstances(),

    // ── ETW (Windows trace) ─────────────────────────────────────────────────
    etwStartTrace: async (params: { name: string; providers: Array<'network' | 'file' | 'registry' | 'process' | 'dns' | 'power'>; outDir?: string }) =>
      requireObs(deps).etwService.createSession(params.name, params.providers, params.outDir),
    etwStopTrace: async (params: { sessionId: string }) => {
      const s = requireObs(deps).etwService.session(params.sessionId)
      if (!s) throw new Error(`etw session not found: ${params.sessionId}`)
      const { buildStopCommands } = await import('../etw/etwService')
      return { commands: buildStopCommands(s) }
    },
    etwParse: async (params: { output: string; format?: 'winevent' | 'counter' }) => {
      const { parseWinEventJson, parseWinEventText, parseCounterJson } = await import('../etw/etwService')
      if (params.format === 'counter') return { counters: parseCounterJson(params.output) }
      return { events: parseWinEventJson(params.output) ?? parseWinEventText(params.output) }
    },
    etwSessions: async () => requireObs(deps).etwService.sessions_(),

    // ── live dashboard hub ──────────────────────────────────────────────────
    liveDashboardState: async () => requireObs(deps).liveDashboard.lastState() ?? (await requireObs(deps).dashboard.state()),
    liveDashboardSubscriberCount: async () => ({ count: requireObs(deps).liveDashboard.subscriberCount() }),
    /** the raw hub (used by the gateway adapter for liveDashboardSubscribe). */
    get liveDashboard() { return requireObs(deps).liveDashboard },
  }
}

export type ObservabilityBridge = ReturnType<typeof createObservabilityBridge>

/** The RPC method names this bridge handles (single source for adapter + tests). */
export const OBSERVABILITY_METHODS = [
  'observability:metricsPrometheus',
  'observability:dashboardState',
  'observability:dashboardSummary',
  'observability:secretsList',
  'observability:secretsSet',
  'observability:secretsDelete',
  'observability:secretsHas',
  'observability:oncallListPolicies',
  'observability:oncallRegisterPolicy',
  'observability:oncallOpenPages',
  'observability:oncallPage',
  'observability:oncallAck',
  'observability:oncallResolve',
  'observability:oncallTick',
  'observability:costSummary',
  'observability:costRecord',
  'observability:costCheck',
  'observability:costListBudgets',
  'observability:costSetBudget',
  'observability:costRemoveBudget',
  'observability:recordingList',
  'observability:recordingStart',
  'observability:recordingStop',
  'observability:recordingReplay',
  'observability:recordingExportCast',
  'observability:recordingDelete',
  'observability:gitopsExport',
  'observability:gitopsDrift',
  'observability:gitopsInSync',
  'observability:gitopsReconcile',
  'observability:playbookLint',
  'observability:playbookHistory',
  'observability:playbookSave',
  'observability:playbookRollback',
  'observability:playbookDiff',
  'observability:cloudSummary',
  'observability:cloudQuery',
  'observability:cloudSync',
  'observability:cloudAddAccount',
  'observability:apmIngestSpans',
  'observability:apmSummary',
  'observability:demIngestBeacon',
  'observability:demSummary',
  'observability:infraCollect',
  'observability:infraClusters',
  'observability:infraUnhealthy',
  'observability:etwStartTrace',
  'observability:etwStopTrace',
  'observability:etwParse',
  'observability:etwSessions',
  'observability:liveDashboardState',
  'observability:liveDashboardSubscriberCount',
] as const

export type ObservabilityMethod = (typeof OBSERVABILITY_METHODS)[number]
