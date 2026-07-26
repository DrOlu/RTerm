import { z } from 'zod'
import type { ToolExecutionContext } from '../types'

/**
 * observability_* agent tools (v2.9.x) — let the agent drive the 9 platform
 * capabilities in natural language: metrics, secrets, on-call paging, AI cost,
 * session recording, GitOps, playbook versioning/lint, cloud inventory, and the
 * live dashboard. Each tool validates input with zod, checks the observability
 * handle is wired, delegates to the pure module, and emits a tool_call event.
 */

function emit(context: ToolExecutionContext, toolName: string, input: unknown, output: string): void {
  context.sendEvent(context.sessionId, {
    messageId: context.messageId,
    type: 'tool_call',
    toolName,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    output,
  })
}

function obs(context: ToolExecutionContext, toolName: string, args: unknown) {
  const o = context.observability
  if (!o) {
    const msg = `${toolName} is not available in this runtime (observability not wired).`
    emit(context, toolName, args, msg)
    return { o: null, msg }
  }
  return { o, msg: null }
}

// ─── metrics ───────────────────────────────────────────────────────────────
export const getMetricsSchema = z.object({
  format: z.enum(['prometheus', 'summary']).optional().describe("'prometheus' = exposition text for a scraper; 'summary' = dashboard summary line (default)."),
})
export async function getMetrics(args: z.infer<typeof getMetricsSchema>, context: ToolExecutionContext): Promise<string> {
  const { o, msg } = obs(context, 'get_metrics', args)
  if (!o) return msg!
  const out = args.format === 'prometheus'
    ? o.metricsExport.renderPrometheus() || '# no host metrics recorded yet'
    : await o.dashboard.summary()
  emit(context, 'get_metrics', args, out)
  return out
}

// ─── secrets ───────────────────────────────────────────────────────────────
export const manageSecretSchema = z.object({
  action: z.enum(['list', 'set', 'delete', 'has']).describe("list metadata (never values), set a secret, delete one, or check existence."),
  key: z.string().optional().describe("Secret key (required for set/delete/has)."),
  value: z.string().optional().describe("Secret value (required for set). Never echoed back."),
  labels: z.record(z.string()).optional().describe("Optional labels (service, scope, connection id)."),
})
export async function manageSecret(args: z.infer<typeof manageSecretSchema>, context: ToolExecutionContext): Promise<string> {
  const { o, msg } = obs(context, 'manage_secret', args)
  if (!o) return msg!
  const v = o.secrets
  if (!v.unlocked()) {
    const m = 'Secrets vault is locked — start RTerm with RTERM_SECRETS_MASTER_KEY set.'
    emit(context, 'manage_secret', args, m)
    return m
  }
  let out: string
  if (args.action === 'list') {
    const items = v.list()
    out = items.length ? items.map((m) => `- ${m.key}${m.labels ? ` ${JSON.stringify(m.labels)}` : ''} (updated ${new Date(m.updatedAt).toISOString()})`).join('\n') : 'No secrets stored.'
  } else if (args.action === 'set') {
    if (!args.key || args.value === undefined) { out = 'set requires key + value.' } else { v.set(args.key, args.value, args.labels); out = `Stored secret '${args.key}'.` }
  } else if (args.action === 'delete') {
    if (!args.key) { out = 'delete requires key.' } else { out = v.delete(args.key) ? `Deleted secret '${args.key}'.` : `No secret '${args.key}'.` }
  } else {
    if (!args.key) { out = 'has requires key.' } else { out = v.has(args.key) ? `'${args.key}' exists.` : `'${args.key}' does not exist.` }
  }
  emit(context, 'manage_secret', args, out)
  return out
}

// ─── on-call / escalation ──────────────────────────────────────────────────
export const manageOncallSchema = z.object({
  action: z.enum(['open_pages', 'page', 'ack', 'resolve', 'list_policies', 'tick']).describe("List open pages, raise a page, ack/resolve a page, list policies, or advance the escalation clock."),
  pageId: z.string().optional().describe("Page id (ack/resolve)."),
  by: z.string().optional().describe("Who is acknowledging (ack)."),
  incidentId: z.string().optional().describe("Incident id (page)."),
  policyId: z.string().optional().describe("Escalation policy id (page)."),
  title: z.string().optional().describe("Page title (page)."),
  severity: z.string().optional().describe("Severity e.g. sev1/sev2/sev3 (page)."),
})
export async function manageOncall(args: z.infer<typeof manageOncallSchema>, context: ToolExecutionContext): Promise<string> {
  const { o, msg } = obs(context, 'manage_oncall', args)
  if (!o) return msg!
  const s = o.oncall
  let out: string
  try {
    if (args.action === 'open_pages') {
      const pages = s.openPages()
      out = pages.length ? pages.map((p) => `- [${p.severity}] ${p.title} (level ${p.levelIndex}, page ${p.id})`).join('\n') : 'No open pages.'
    } else if (args.action === 'list_policies') {
      const pols = s.listPolicies()
      out = pols.length ? pols.map((p) => `- ${p.name} (${p.id}): ${p.levels.length} level(s)`).join('\n') : 'No escalation policies registered.'
    } else if (args.action === 'page') {
      if (!args.incidentId || !args.policyId || !args.title || !args.severity) { out = 'page requires incidentId, policyId, title, severity.' } else {
        const p = await s.page({ incidentId: args.incidentId, policyId: args.policyId, title: args.title, severity: args.severity })
        out = `Paged (page ${p.id}) at level 0.`
      }
    } else if (args.action === 'ack') {
      if (!args.pageId || !args.by) { out = 'ack requires pageId + by.' } else { s.acknowledge(args.pageId, args.by); out = `Page ${args.pageId} acknowledged by ${args.by}.` }
    } else if (args.action === 'resolve') {
      if (!args.pageId) { out = 'resolve requires pageId.' } else { s.resolve(args.pageId); out = `Page ${args.pageId} resolved.` }
    } else {
      const esc = await s.tick()
      out = esc.length ? `Escalated ${esc.length} page(s).` : 'No pages needed escalation.'
    }
  } catch (e) { out = `on-call error: ${e instanceof Error ? e.message : String(e)}` }
  emit(context, 'manage_oncall', args, out)
  return out
}

// ─── AI cost ───────────────────────────────────────────────────────────────
export const getCostSchema = z.object({
  action: z.enum(['summary', 'check', 'list_budgets']).describe("summary of spend, check a run against budgets, or list budgets."),
  period: z.enum(['daily', 'monthly']).optional().describe("Window for summary (default daily)."),
  model: z.string().optional().describe("Filter by model / the model to check."),
  profileId: z.string().optional().describe("Filter by profile / the profile to check."),
})
export async function getCost(args: z.infer<typeof getCostSchema>, context: ToolExecutionContext): Promise<string> {
  const { o, msg } = obs(context, 'get_cost', args)
  if (!o) return msg!
  let out: string
  if (args.action === 'summary') {
    const s = o.cost.summarize({ period: args.period ?? 'daily', model: args.model, profileId: args.profileId })
    const lines = s.byModel.map((m) => `  ${m.model}: $${m.usd.toFixed(4)} (${m.promptTokens}in/${m.completionTokens}out)`).join('\n')
    out = `Spend (${args.period ?? 'daily'}): $${s.totalUsd.toFixed(4)} total.${lines ? '\n' + lines : ''}`
  } else if (args.action === 'check') {
    const r = o.cost.check({ model: args.model, profileId: args.profileId })
    out = `Budget check → ${r.action.toUpperCase()}${r.statuses.length ? ` (${r.statuses.map((s) => `${s.budget.id}=${(s.ratio * 100).toFixed(0)}%`).join(', ')})` : ' (no matching budgets)'}.`
  } else {
    const b = o.cost.listBudgets()
    out = b.length ? b.map((x) => `- ${x.id}: ${x.model ?? '*'}/${x.profileId ?? '*'} ${x.period} cap $${x.capUsd}`).join('\n') : 'No budgets configured.'
  }
  emit(context, 'get_cost', args, out)
  return out
}

// ─── session recording ─────────────────────────────────────────────────────
export const manageRecordingSchema = z.object({
  action: z.enum(['list', 'start', 'stop', 'replay', 'export_cast', 'delete']).describe("List, start, stop, replay, export (.cast), or delete a recording."),
  recordingId: z.string().optional().describe("Recording id (stop/replay/export_cast/delete)."),
  terminalId: z.string().optional().describe("Terminal to record (start)."),
  title: z.string().optional().describe("Title (start)."),
  fromSec: z.number().optional().describe("Replay start offset seconds."),
  durationSec: z.number().optional().describe("Replay duration seconds."),
})
export async function manageRecording(args: z.infer<typeof manageRecordingSchema>, context: ToolExecutionContext): Promise<string> {
  const { o, msg } = obs(context, 'manage_recording', args)
  if (!o) return msg!
  const r = o.recording
  let out: string
  try {
    if (args.action === 'list') {
      const list = r.list()
      out = list.length ? list.map((x) => `- ${x.id} (${x.terminalId}) ${x.events} events${x.endedAt ? ' [stopped]' : ' [recording]'}`).join('\n') : 'No recordings.'
    } else if (args.action === 'start') {
      if (!args.terminalId) { out = 'start requires terminalId.' } else {
        // Route through TerminalService.startRecording so the terminal is registered in
        // activeRecordings — without it, the live-output feed (handleData) never sees a
        // recordingId for this terminal and nothing is captured. (Calling r.start()
        // directly bypassed that registration and produced 0-event recordings.)
        const ts = context.terminalService
        const id = ts && typeof ts.startRecording === 'function'
          ? ts.startRecording(args.terminalId, { title: args.title })
          : r.start(args.terminalId, { title: args.title })
        out = `Recording started: ${id}`
      }
    } else if (args.action === 'stop') {
      if (!args.recordingId) { out = 'stop requires recordingId.' } else {
        const rec = r.stop(args.recordingId)
        // Also deregister from activeRecordings so the terminal is no longer flagged
        // as recording (symmetric with the TerminalService.startRecording fix above).
        try {
          const ts = context.terminalService as unknown as { activeRecordings?: Map<string, string>; stopRecording?: (t: string) => unknown }
          const termId = (rec as { terminalId?: string }).terminalId ?? args.terminalId
          if (termId && ts?.activeRecordings instanceof Map) {
            if (ts.activeRecordings.get(termId) === args.recordingId) ts.activeRecordings.delete(termId)
          }
        } catch { /* best-effort deregistration */ }
        out = `Recording ${args.recordingId} stopped (${rec.events.length} events).`
      }
    } else if (args.action === 'replay') {
      if (!args.recordingId) { out = 'replay requires recordingId.' } else {
        const ev = r.replay(args.recordingId, { fromSec: args.fromSec, durationSec: args.durationSec })
        out = ev.length ? ev.map((e) => `[+${e.t.toFixed(1)}s] ${e.data}`).join('') : '(no events in window)'
      }
    } else if (args.action === 'export_cast') {
      if (!args.recordingId) { out = 'export_cast requires recordingId.' } else { out = r.exportCast(args.recordingId) }
    } else {
      if (!args.recordingId) { out = 'delete requires recordingId.' } else { out = r.delete(args.recordingId) ? `Deleted ${args.recordingId}.` : `No recording ${args.recordingId}.` }
    }
  } catch (e) { out = `recording error: ${e instanceof Error ? e.message : String(e)}` }
  emit(context, 'manage_recording', args, out)
  return out
}

// ─── gitops ────────────────────────────────────────────────────────────────
export const manageGitopsSchema = z.object({
  action: z.enum(['export', 'drift', 'in_sync']).describe("export the live desired-state manifest, or diff/verify a manifest against live."),
  manifest: z.any().optional().describe("A StateManifest (for drift/in_sync)."),
})
export async function manageGitops(args: z.infer<typeof manageGitopsSchema>, context: ToolExecutionContext): Promise<string> {
  const { o, msg } = obs(context, 'manage_gitops', args)
  if (!o) return msg!
  let out: string
  try {
    if (args.action === 'export') {
      const m = await o.gitops.exportLive()
      out = `Exported manifest: ${m.entities.length} entities, stateHash ${m.stateHash.slice(0, 12)}…`
    } else if (args.action === 'drift') {
      if (!args.manifest) { out = 'drift requires a manifest.' } else {
        const d = await o.gitops.drift(args.manifest)
        out = d.length ? d.map((x) => `- ${x.id} (${x.kind}): ${x.drift}`).join('\n') : 'No drift — live matches the manifest.'
      }
    } else {
      if (!args.manifest) { out = 'in_sync requires a manifest.' } else { out = (await o.gitops.inSync(args.manifest)) ? 'In sync.' : 'Out of sync (drift present).' }
    }
  } catch (e) { out = `gitops error: ${e instanceof Error ? e.message : String(e)}` }
  emit(context, 'manage_gitops', args, out)
  return out
}

// ─── playbook versioning + lint ────────────────────────────────────────────
export const managePlaybookVersionSchema = z.object({
  action: z.enum(['lint', 'history', 'rollback', 'diff']).describe("lint a playbook def, list version history, roll back, or diff two versions."),
  playbookId: z.string().optional().describe("Playbook id (history/rollback/diff)."),
  def: z.any().optional().describe("Playbook definition (lint)."),
  version: z.number().int().optional().describe("Version to roll back to (rollback)."),
  a: z.number().int().optional().describe("First version (diff)."),
  b: z.number().int().optional().describe("Second version (diff)."),
})
export async function managePlaybookVersion(args: z.infer<typeof managePlaybookVersionSchema>, context: ToolExecutionContext): Promise<string> {
  const { o, msg } = obs(context, 'manage_playbook_version', args)
  if (!o) return msg!
  let out: string
  try {
    if (args.action === 'lint') {
      if (!args.def) { out = 'lint requires a playbook def.' } else {
        const issues = o.playbooks.lint(args.def)
        out = issues.length ? issues.map((i) => `- [${i.severity}] ${i.rule}: ${i.message}`).join('\n') : 'Playbook lints clean.'
      }
    } else if (args.action === 'history') {
      if (!args.playbookId) { out = 'history requires playbookId.' } else {
        const h = o.playbooks.versioning.history(args.playbookId)
        out = h.length ? h.map((v) => `- v${v.version} (${v.hash})${v.comment ? ` ${v.comment}` : ''}`).join('\n') : `No versions for '${args.playbookId}'.`
      }
    } else if (args.action === 'rollback') {
      if (!args.playbookId || args.version === undefined) { out = 'rollback requires playbookId + version.' } else {
        const v = o.playbooks.versioning.rollback(args.playbookId, args.version)
        out = `Rolled back to v${args.version} → new v${v.version}.`
      }
    } else {
      if (!args.playbookId || args.a === undefined || args.b === undefined) { out = 'diff requires playbookId + a + b.' } else {
        out = o.playbooks.versioning.diff(args.playbookId, args.a, args.b)
      }
    }
  } catch (e) { out = `playbook error: ${e instanceof Error ? e.message : String(e)}` }
  emit(context, 'manage_playbook_version', args, out)
  return out
}

// ─── cloud inventory ───────────────────────────────────────────────────────
export const getCloudInventorySchema = z.object({
  action: z.enum(['summary', 'query', 'sync']).describe("summary counts, query resources, or pull fresh inventory."),
  provider: z.enum(['aws', 'gcp', 'azure']).optional().describe("Filter by provider."),
  state: z.string().optional().describe("Filter by state (running/stopped/…)."),
  region: z.string().optional().describe("Filter by region."),
})
export async function getCloudInventory(args: z.infer<typeof getCloudInventorySchema>, context: ToolExecutionContext): Promise<string> {
  const { o, msg } = obs(context, 'get_cloud_inventory', args)
  if (!o) return msg!
  let out: string
  try {
    if (args.action === 'summary') {
      const s = o.cloud.summary()
      out = `Cloud inventory: ${s.total} resources. By provider: ${JSON.stringify(s.byProvider)}. By state: ${JSON.stringify(s.byState)}.`
    } else if (args.action === 'query') {
      const r = o.cloud.query({ provider: args.provider, state: args.state, region: args.region })
      out = r.length ? r.map((x) => `- [${x.provider}] ${x.name} (${x.machineType ?? x.kind}) ${x.state ?? ''} ${x.region ?? ''}`).join('\n') : 'No matching cloud resources.'
    } else {
      const r = await o.cloud.sync()
      out = `Synced ${r.added} resources${r.errors.length ? `, ${r.errors.length} account error(s)` : ''}.`
    }
  } catch (e) { out = `cloud error: ${e instanceof Error ? e.message : String(e)}` }
  emit(context, 'get_cloud_inventory', args, out)
  return out
}

// ─── live dashboard ────────────────────────────────────────────────────────
export const getLiveDashboardSchema = z.object({
  action: z.enum(['state', 'subscribers']).describe("'state' = current dashboard state; 'subscribers' = connected client count."),
})
export async function getLiveDashboard(args: z.infer<typeof getLiveDashboardSchema>, context: ToolExecutionContext): Promise<string> {
  const { o, msg } = obs(context, 'get_live_dashboard', args)
  if (!o) return msg!
  let out: string
  if (args.action === 'subscribers') {
    out = `${o.liveDashboard.subscriberCount()} dashboard subscriber(s) connected.`
  } else {
    const s = await o.dashboard.summary()
    out = s
  }
  emit(context, 'get_live_dashboard', args, out)
  return out
}

// ─── APM (OTLP span ingestion) ─────────────────────────────────────────────
export const ingestApmSpansSchema = z.object({
  payload: z.any().describe("OTLP/HTTP-JSON payload: {resourceSpans:[...]} with spans (traceId/spanId/name/startTimeUnixNano/endTimeUnixNano/status)."),
  defaultService: z.string().optional().describe("Fallback service name when a span has none."),
})
export async function ingestApmSpans(args: z.infer<typeof ingestApmSpansSchema>, context: ToolExecutionContext): Promise<string> {
  const { o, msg } = obs(context, 'ingest_apm_spans', args)
  if (!o) return msg!
  const { ingestOtlp } = await import('../../apm/spanLedger')
  const n = ingestOtlp(o.spanLedger, args.payload, args.defaultService)
  const out = `Ingested ${n} APM span(s) into the trace store.`
  emit(context, 'ingest_apm_spans', args, out)
  return out
}

export const getApmSummarySchema = z.object({})
export async function getApmSummary(_args: z.infer<typeof getApmSummarySchema>, context: ToolExecutionContext): Promise<string> {
  const { o, msg } = obs(context, 'get_apm_summary', _args)
  if (!o) return msg!
  const stats = (o.spanLedger.serviceStats() as unknown) as Array<{ service: string; spans: number; errors?: number; p95Ms?: number }>
  const out = stats.length
    ? `APM: ${o.spanLedger.size()} spans across ${stats.length} service(s). ` + stats.map((x) => `${x.service}(${x.spans}${x.errors ? ', ' + x.errors + ' err' : ''})`).join(', ')
    : 'APM: no spans ingested yet.'
  emit(context, 'get_apm_summary', _args, out)
  return out
}

// ─── DEM (RUM beacon ingestion) ────────────────────────────────────────────
export const ingestDemBeaconSchema = z.object({
  payload: z.any().describe("RUM beacon: {page, route?, region?, userAgent?, lcpMs?, inpMs?, cls?, ttfbMs?, jsErrors?, at?}."),
})
export async function ingestDemBeacon(args: z.infer<typeof ingestDemBeaconSchema>, context: ToolExecutionContext): Promise<string> {
  const { o, msg } = obs(context, 'ingest_dem_beacon', args)
  if (!o) return msg!
  const s = o.rumLedger.ingestBeacon(args.payload)
  const out = s ? `Ingested RUM beacon for ${s.page}${s.lcpMs ? ` (LCP ${s.lcpMs}ms)` : ''}.` : 'Beacon ignored — needs a `page` field.'
  emit(context, 'ingest_dem_beacon', args, out)
  return out
}

export const getDemSummarySchema = z.object({})
export async function getDemSummary(_args: z.infer<typeof getDemSummarySchema>, context: ToolExecutionContext): Promise<string> {
  const { o, msg } = obs(context, 'get_dem_summary', _args)
  if (!o) return msg!
  const pages = o.rumLedger.pageStats() as Array<{ page: string; sessions: number; errorRate?: number }>
  const out = pages.length
    ? `DEM: ${o.rumLedger.size()} sessions across ${pages.length} page(s). ` + pages.map((p) => `${p.page}(${p.sessions}${p.errorRate ? `, ${(p.errorRate * 100).toFixed(0)}% err` : ''})`).join(', ')
    : 'DEM: no RUM sessions ingested yet.'
  emit(context, 'get_dem_summary', _args, out)
  return out
}

// ─── Infra (k8s collect) ───────────────────────────────────────────────────
interface KubectlPodContainerStatus { ready?: boolean; restartCount?: number }
interface KubectlPodItem { metadata?: { name?: string; namespace?: string }; status?: { phase?: string; containerStatuses?: KubectlPodContainerStatus[] } }
interface KubectlPodList { items?: KubectlPodItem[] }

export const collectInfraSchema = z.object({
  context: z.string().optional().describe("Cluster context name (default 'default')."),
  kubectlJson: z.any().optional().describe("Parsed `kubectl get pods -A -o json` payload (or its text). If omitted, runs kubectl on the local shell."),
})
export async function collectInfra(args: z.infer<typeof collectInfraSchema>, context: ToolExecutionContext): Promise<string> {
  const { o, msg } = obs(context, 'collect_infra', args)
  if (!o) return msg!
  const { parseKubectlPods } = await import('../../infra/infraMonitor')
  const clusterCtx = args.context ?? 'default'
  let out: string
  try {
    let payload = args.kubectlJson
    if (payload === undefined) {
      const { execFile } = await import('node:child_process')
      payload = await new Promise<string>((resolve, reject) => {
        // text table output (NAMESPACE NAME READY STATUS RESTARTS AGE) — what parseKubectlPods reads
        execFile('kubectl', ['get', 'pods', '-A'], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
          if (err) return reject(err)
          resolve(stdout)
        })
      })
    }
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
    let pods = parseKubectlPods(text)
    // parseKubectlPods reads the kubectl text table; render a JSON object to that shape if needed.
    if (pods.length === 0 && typeof payload === 'object' && payload !== null) {
      const jsonObj = payload as KubectlPodList
      const items = jsonObj.items ?? []
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
    const health = o.infraMonitor.recordCluster(clusterCtx, pods, [])
    out = `k8s ${clusterCtx}: ${pods.length} pods, ${health.notReadyPods} not-ready, ${health.crashLoopPods} CrashLoopBackOff.`
  } catch (e) {
    out = `infra collect failed (kubectl or cluster unavailable): ${e instanceof Error ? e.message : String(e)}`
  }
  emit(context, 'collect_infra', args, out)
  return out
}

// ─── ETW (Windows trace) ───────────────────────────────────────────────────
export const manageEtwSchema = z.object({
  action: z.enum(['start', 'stop', 'parse', 'sessions']).describe("start a trace, stop it, parse captured output, or list sessions."),
  name: z.string().optional().describe("Trace name (start)."),
  providers: z.array(z.enum(['network', 'file', 'registry', 'process', 'dns', 'power'])).optional().describe("ETW providers to trace (start)."),
  sessionId: z.string().optional().describe("Session id (stop)."),
  output: z.string().optional().describe("Captured Get-WinEvent/Get-Counter output (parse)."),
  format: z.enum(['winevent', 'counter']).optional().describe("Parse format (parse)."),
})
export async function manageEtw(args: z.infer<typeof manageEtwSchema>, context: ToolExecutionContext): Promise<string> {
  const { o, msg } = obs(context, 'manage_etw', args)
  if (!o) return msg!
  const svc = o.etwService
  let out: string
  try {
    if (args.action === 'start') {
      if (!args.name || !args.providers?.length) { out = 'start requires name + providers.' } else {
        const s = svc.createSession(args.name, args.providers)
        const { buildStartCommands } = await import('../../etw/etwService')
        out = `ETW session ${s.id} created (${args.providers.join(', ')}). Start commands:\n${buildStartCommands(s).join('\n')}`
      }
    } else if (args.action === 'stop') {
      if (!args.sessionId) { out = 'stop requires sessionId.' } else {
        const s = svc.session(args.sessionId)
        if (!s) { out = `No ETW session ${args.sessionId}.` } else {
          const { buildStopCommands } = await import('../../etw/etwService')
          out = `Stop commands for ${args.sessionId}:\n${buildStopCommands(s).join('\n')}`
        }
      }
    } else if (args.action === 'parse') {
      if (!args.output) { out = 'parse requires output.' } else {
        const { parseWinEventJson, parseWinEventText, parseCounterJson } = await import('../../etw/etwService')
        if (args.format === 'counter') {
          const c = parseCounterJson(args.output)
          out = `${c.length} counter sample(s).`
        } else {
          const ev = parseWinEventJson(args.output) ?? parseWinEventText(args.output)
          out = `${ev.length} event(s) parsed.`
        }
      }
    } else {
      const sessions = svc.sessions_()
      out = sessions.length ? sessions.map((s) => `- ${s.id} (${s.name}): ${s.providers.join(',')}`).join('\n') : 'No ETW sessions.'
    }
  } catch (e) { out = `etw error: ${e instanceof Error ? e.message : String(e)}` }
  emit(context, 'manage_etw', args, out)
  return out
}
