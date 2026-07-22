/**
 * netdata-rterm plugin — Netdata integration for RTerm.
 *
 * Ingests Netdata alert webhooks (per the Netdata Cloud webhook schema),
 * correlates anomalies with RTerm's metrics ledger + incident history for
 * agent RCA, and fires triggers for auto-remediation playbooks.
 *
 * Netdata webhook alert payload fields (from Netdata docs):
 *   message, alert, info, chart, context, space, rooms, family, class,
 *   severity (warning|critical|clear), date (ISO8601), duration,
 *   additional_active_critical_alerts, additional_active_warning_alerts,
 *   alert_url
 *
 * Netdata webhook reachability payload fields:
 *   message, node, space, rooms, status (up|down), date, duration
 */

// --- Pure: parse a Netdata webhook alert payload ---
export function parseNetdataAlert(payload) {
  if (!payload || typeof payload !== 'object') return null

  // Alert notification
  if (payload.alert && payload.severity) {
    return {
      kind: 'alert',
      alert: String(payload.alert),
      message: String(payload.message ?? ''),
      info: String(payload.info ?? ''),
      chart: String(payload.chart ?? ''),
      context: String(payload.context ?? ''),
      space: String(payload.space ?? ''),
      family: String(payload.family ?? ''),
      class: String(payload.class ?? ''),
      severity: String(payload.severity), // warning | critical | clear
      date: String(payload.date ?? ''),
      duration: String(payload.duration ?? ''),
      alertUrl: String(payload.alert_url ?? ''),
      additionalCritical: Number(payload.additional_active_critical_alerts ?? 0),
      additionalWarning: Number(payload.additional_active_warning_alerts ?? 0),
      // host is inferred from space/node; Netdata Cloud sends space name.
      host: String(payload.space ?? 'unknown'),
    }
  }

  // Reachability notification
  if (payload.node && payload.status) {
    return {
      kind: 'reachability',
      message: String(payload.message ?? ''),
      node: String(payload.node),
      space: String(payload.space ?? ''),
      status: String(payload.status), // up | down
      date: String(payload.date ?? ''),
      duration: String(payload.duration ?? ''),
      host: String(payload.node ?? 'unknown'),
    }
  }

  return null
}

// --- Pure: map Netdata severity to RTerm alert severity ---
export function mapSeverity(netdataSeverity) {
  const s = String(netdataSeverity).toLowerCase()
  if (s === 'critical') return 'critical'
  if (s === 'warning') return 'warning'
  if (s === 'clear') return 'info' // alert cleared
  return 'info'
}

// --- Pure: build an RTerm alert fingerprint from a parsed Netdata alert ---
export function buildFingerprint(parsed) {
  if (!parsed) return ''
  if (parsed.kind === 'reachability') {
    return `netdata:reachability:${parsed.host}:${parsed.status}`
  }
  return `netdata:${parsed.host}:${parsed.alert}:${parsed.severity}`
}

// --- Pure: build a trigger event from a parsed Netdata alert ---
export function toTriggerEvent(parsed) {
  if (!parsed) return null
  const severity = parsed.kind === 'reachability'
    ? (parsed.status === 'down' ? 'critical' : 'info')
    : mapSeverity(parsed.severity)

  return {
    source: 'netdata',
    fingerprint: buildFingerprint(parsed),
    title: parsed.kind === 'reachability'
      ? `${parsed.host} ${parsed.status === 'down' ? 'is DOWN' : 'is UP'}`
      : `[Netdata] ${parsed.alert} on ${parsed.host}`,
    severity,
    detail: parsed.message || parsed.info || '',
    labels: {
      host: parsed.host,
      alert: parsed.alert ?? '',
      chart: parsed.chart ?? '',
      context: parsed.context ?? '',
      netdata_severity: parsed.severity ?? parsed.status ?? '',
      netdata_space: parsed.space ?? '',
    },
    at: parsed.date ? new Date(parsed.date).getTime() : Date.now(),
  }
}

// --- Pure: correlate a Netdata alert with RTerm's metrics + incidents ---
export function correlateWithRterm(parsed, metricsLedger, incidentLedger) {
  if (!parsed) return { recentMetrics: null, openIncidents: [], correlation: '' }

  const host = parsed.host

  // Pull recent metrics for the host from the ledger.
  let recentMetrics = null
  if (metricsLedger && typeof metricsLedger.snapshot === 'function') {
    try {
      recentMetrics = metricsLedger.snapshot(host)
    } catch { /* best-effort */ }
  }

  // Pull open incidents for the host.
  let openIncidents = []
  if (incidentLedger && typeof incidentLedger.list === 'function') {
    try {
      const all = incidentLedger.list()
      openIncidents = all.filter(
        (inc) => Array.isArray(inc.affected) && inc.affected.includes(host) && inc.status !== 'resolved'
      )
    } catch { /* best-effort */ }
  }

  // Build a correlation summary for the agent.
  const parts = []
  if (recentMetrics) {
    parts.push(`Recent metrics for ${host}: ${JSON.stringify(recentMetrics).slice(0, 500)}`)
  }
  if (openIncidents.length > 0) {
    parts.push(`${openIncidents.length} open incident(s) for ${host}: ${openIncidents.map((i) => i.title).join('; ')}`)
  }
  if (parsed.kind === 'alert' && parsed.additionalCritical > 0) {
    parts.push(`${parsed.additionalCritical} additional critical alert(s) on the same node`)
  }

  const correlation = parts.length > 0
    ? `Netdata alert "${parsed.alert ?? parsed.message}" on ${host} correlates with: ${parts.join('. ')}.`
    : `No prior RTerm context for ${host}.`

  return { recentMetrics, openIncidents, correlation }
}

// --- Plugin entry: register tools, triggers, panel ---
export function register(ctx) {
  const { registerTool, registerTrigger, registerPanel, exec, readLedger, log } = ctx

  // Tool: netdata_alert_summary — summarize recent Netdata alerts for a host.
  registerTool({
    name: 'netdata_alert_summary',
    description: 'Summarize recent Netdata alerts for a host. Returns parsed alert details including severity, chart, context, and duration.',
    params: { host: { type: 'string', description: 'Host name to summarize alerts for' } },
    handler: async (params) => {
      const host = params?.host ?? 'unknown'
      log(`[netdata] alert summary requested for ${host}`)
      return { host, summary: `No cached Netdata alerts for ${host}. Configure Netdata Cloud to send webhooks to RTerm's gateway.` }
    },
  })

  // Tool: netdata_correlate — correlate a Netdata alert with RTerm's metrics + incidents.
  registerTool({
    name: 'netdata_correlate',
    description: 'Correlate a Netdata alert with RTerm metrics ledger and incident history for root-cause analysis. Returns recent metrics, open incidents, and a correlation summary.',
    params: {
      alert: { type: 'object', description: 'Parsed Netdata alert payload (from webhook)' },
    },
    handler: async (params) => {
      const parsed = parseNetdataAlert(params?.alert)
      if (!parsed) return { error: 'Invalid Netdata alert payload' }

      const metrics = readLedger ? readLedger('metrics') : null
      const incidents = readLedger ? readLedger('incidents') : null

      // readLedger returns ledger-like objects or plain data.
      const metricsLedger = metrics && typeof metrics === 'object' && typeof metrics.snapshot === 'function' ? metrics : null
      const incidentLedger = incidents && typeof incidents === 'object' && typeof incidents.list === 'function' ? incidents : null

      const result = correlateWithRterm(parsed, metricsLedger, incidentLedger)
      log(`[netdata] correlated alert "${parsed.alert ?? parsed.message}" on ${parsed.host}: ${result.correlation}`)
      return { parsed, ...result }
    },
  })

  // Trigger: netdata_critical_alert — fires when a Netdata webhook delivers a critical alert.
  registerTrigger({
    name: 'netdata_critical_alert',
    description: 'Fires when Netdata sends a critical-severity alert via webhook. Use for auto-remediation playbooks.',
    match: (event) => {
      if (event?.source !== 'netdata') return false
      return event.severity === 'critical'
    },
    action: 'run-playbook', // operator assigns a remediation playbook
  })

  // Trigger: netdata_warning_alert — fires when a Netdata webhook delivers a warning alert.
  registerTrigger({
    name: 'netdata_warning_alert',
    description: 'Fires when Netdata sends a warning-severity alert via webhook. Use for investigation/diagnosis playbooks.',
    match: (event) => {
      if (event?.source !== 'netdata') return false
      return event.severity === 'warning'
    },
    action: 'propose-change', // propose a MOP change for investigation
  })

  // Panel: netdata-alert-feed — dashboard panel showing recent Netdata alerts.
  registerPanel({
    name: 'netdata-alert-feed',
    title: 'Netdata Alert Feed',
    render: (data) => {
      const alerts = Array.isArray(data) ? data : []
      const rows = alerts.map((a) =>
        `<tr><td>${a.host ?? ''}</td><td>${a.alert ?? a.message ?? ''}</td><td>${a.severity ?? a.status ?? ''}</td><td>${a.date ?? ''}</td></tr>`
      ).join('')
      return `<div class="netdata-alert-feed"><h3>Netdata Alerts</h3><table><thead><tr><th>Host</th><th>Alert</th><th>Severity</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table></div>`
    },
  })

  log('[netdata] netdata-rterm plugin registered: 2 tools, 2 triggers, 1 panel')
}

export default { register, parseNetdataAlert, mapSeverity, buildFingerprint, toTriggerEvent, correlateWithRterm }
