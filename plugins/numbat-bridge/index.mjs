/**
 * numbat-bridge — RTerm ↔ Numbat (endpoint AI-agent detection) integration.
 *
 * Numbat = EDR for AI agents: endpoint visibility, CEL detection, forensic
 * reconstruction. RTerm = control plane. This bridge wires them:
 *   - DEPLOY: install/manage the numbat binary + hooks on hosts (via playbooks/exec).
 *   - INGEST: accept Numbat findings (NDJSON records) delivered over HTTP or read
 *     from a local records file, normalize them, and feed RTerm triggers.
 *   - ACT: turn detections into governed actions (playbooks, MOP changes, incidents).
 *
 * Numbat detects; RTerm responds.
 *
 * Config (settings.numbat, or env):
 *   enabled        — master switch (default true)
 *   binaryPath     — path to the numbat binary (default "numbat" on PATH)
 *   recordsPath    — local NDJSON records file to tail (default ~/.numbat/records.ndjson)
 *   ingestToken    — bearer token the HTTP ingest endpoint requires (vault secretRef ok)
 *   minSeverity    — only ingest findings at/above this severity (info|low|medium|high|critical)
 */

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)

// ─── config ─────────────────────────────────────────────────────────────────

export function resolveConfig(ctx = {}, env = process.env) {
  const s = (typeof ctx.getSettings === 'function' ? ctx.getSettings() : ctx.settings) || {}
  const b = s.numbat || {}
  return {
    enabled: b.enabled !== false,
    binaryPath: b.binaryPath || env.NUMBAT_BIN || 'numbat',
    recordsPath: b.recordsPath || env.NUMBAT_RECORDS || `${process.env.HOME}/.numbat/records.ndjson`,
    ingestToken: b.ingestToken || undefined,
    minSeverity: b.minSeverity || 'low',
  }
}

const SEVERITY_ORDER = ['info', 'low', 'medium', 'high', 'critical']
function severityAtLeast(sev, min) {
  const i = SEVERITY_ORDER.indexOf(String(sev ?? 'info').toLowerCase())
  const m = SEVERITY_ORDER.indexOf(String(min ?? 'low').toLowerCase())
  return (i < 0 ? 0 : i) >= (m < 0 ? 0 : m)
}

// ─── record normalization ───────────────────────────────────────────────────

/** Normalize a Numbat NDJSON record (event/finding/enforcement/indicator/scan) into
 * a compact RTerm finding. Returns null for records that shouldn't be ingested. */
export function normalizeRecord(rec, cfg) {
  if (!rec || typeof rec !== 'object') return null
  const type = rec.record_type ?? rec.type ?? 'event'
  const severity = rec.severity ?? rec.rule_severity ?? rec.level ?? 'info'
  // Only findings + high-signal events become trigger inputs; raw events are noise.
  const isFinding = type === 'finding' || type === 'enforcement' || type === 'indicator'
  if (!isFinding && type === 'event' && !severityAtLeast(severity, 'high')) return null
  if (!severityAtLeast(severity, cfg.minSeverity)) return null
  return {
    id: rec.id ?? rec.record_id ?? randomUUID(),
    source: 'numbat',
    recordType: type,
    severity,
    ruleId: rec.rule_id ?? rec.rule?.id ?? undefined,
    title: rec.title ?? rec.rule_name ?? rec.rule?.name ?? type,
    agent: rec.agent ?? rec.agent_id ?? rec.source?.agent ?? undefined,
    host: rec.host ?? rec.hostname ?? rec.source?.host ?? undefined,
    summary: rec.summary ?? rec.description ?? rec.content_preview ?? undefined,
    ts: rec.ts ?? rec.timestamp ?? new Date().toISOString(),
    raw: rec,
  }
}

/** Parse an NDJSON blob (one JSON record per line) into normalized findings. */
export function parseNdjson(text, cfg) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try { const n = normalizeRecord(JSON.parse(t), cfg); if (n) out.push(n) } catch { /* skip malformed */ }
  }
  return out
}

// ─── deploy (run numbat commands on a host) ─────────────────────────────────

/** Build the numbat CLI argv for a deploy action. Pure — testable. */
export function buildDeployCommand(action, opts = {}) {
  const agent = opts.agent || 'codex'
  switch (action) {
    case 'inventory': return ['agents']
    case 'scan': return opts.agent ? ['scan', '--agent', agent] : ['scan']
    case 'install-monitor': return ['hook', 'install', '--agent', agent, '--emit', opts.emit ?? 'all']
    case 'install-enforce': return ['hook', 'install', '--agent', agent, '--emit', opts.emit ?? 'all', ...(opts.rulesDir ? ['--rules-dir', opts.rulesDir] : []), '--enforce']
    case 'status': return ['hook', 'status', '--agent', agent]
    case 'uninstall': return ['hook', 'uninstall', '--agent', agent]
    default: throw new Error(`unknown numbat deploy action: ${action}`)
  }
}

/** Run a numbat command via the plugin's exec capability (local or remote host). */
async function runNumbat(ctx, cfg, argv, target) {
  const cmdline = [cfg.binaryPath, ...argv].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
  // Prefer the plugin exec/runCommand capability when available (policy-gated).
  if (typeof ctx.runCommand === 'function') {
    return ctx.runCommand({ command: cmdline, target })
  }
  if (typeof ctx.exec === 'function') {
    return ctx.exec(cmdline, { target })
  }
  // Local fallback via child_process.
  const { execFile } = require('node:child_process')
  return new Promise((resolve) => {
    execFile(cfg.binaryPath, argv, { timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, exitCode: err?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: err ? String(err.message) : undefined })
    })
  })
}

// ─── plugin registration ────────────────────────────────────────────────────

async function guarded(fn, log) {
  try { return await fn() } catch (e) {
    const msg = e?.message ?? String(e)
    log?.(`[numbat] ${msg}`)
    return { error: msg, hint: 'Is numbat installed? (go install github.com/perplexityai/numbat/cmd/numbat@latest, or download a release). Configure settings.numbat.' }
  }
}

export function register(ctx) {
  const { registerTool, registerTrigger, registerPanel, log } = ctx
  const cfg = resolveConfig(ctx)

  registerTool({
    name: 'numbat_health',
    description: 'Check the numbat binary is present and report its version + the configured records path.',
    params: {},
    handler: async () => guarded(async () => {
      const r = await runNumbat(ctx, cfg, ['version'])
      return { binaryPath: cfg.binaryPath, recordsPath: cfg.recordsPath, ...r }
    }, log),
  })

  registerTool({
    name: 'numbat_deploy',
    description: 'Deploy/manage numbat on a host: inventory agents, scan, install monitor-only or enforce hooks, check status, or uninstall. Runs the numbat CLI via the policy-gated exec path (local or a target host).',
    params: {
      action: { type: 'string', description: 'inventory | scan | install-monitor | install-enforce | status | uninstall' },
      agent: { type: 'string', description: 'Target agent (e.g. codex)', optional: true },
      target: { type: 'string', description: 'Host/terminal to run on (default local)', optional: true },
      rulesDir: { type: 'string', description: 'Custom rules dir (for enforce)', optional: true },
      emit: { type: 'string', description: 'Emit mode (default all)', optional: true },
    },
    handler: async (p) => guarded(async () => {
      if (!p?.action) return { error: 'numbat_deploy needs an action' }
      const argv = buildDeployCommand(p.action, p)
      const r = await runNumbat(ctx, cfg, argv, p?.target)
      return { action: p.action, argv, ...r }
    }, log),
  })

  registerTool({
    name: 'numbat_ingest',
    description: 'Ingest Numbat NDJSON records (events/findings/enforcement/indicators) — normalize them into RTerm findings and fire the numbat_finding trigger for each. Pass ndjson text directly or read from the configured records file.',
    params: {
      ndjson: { type: 'string', description: 'NDJSON records (one JSON per line)', optional: true },
      fromFile: { type: 'boolean', description: 'Read from recordsPath instead of inline ndjson', optional: true },
    },
    handler: async (p) => guarded(async () => {
      let text = p?.ndjson
      if (!text && (p?.fromFile || !p?.ndjson)) {
        const fs = require('node:fs')
        try { text = fs.readFileSync(cfg.recordsPath, 'utf8') } catch { text = '' }
      }
      const findings = parseNdjson(text ?? '', cfg)
      // Fire a trigger event per finding (the trigger engine routes these).
      if (typeof ctx.emitEvent === 'function') {
        for (const f of findings) ctx.emitEvent({ source: 'numbat', ...f })
      }
      return { ingested: findings.length, findings }
    }, log),
  })

  registerTool({
    name: 'numbat_findings_summary',
    description: 'Summarize Numbat findings from the records file by severity + rule + agent (quick threat picture).',
    params: {},
    handler: async () => guarded(async () => {
      const fs = require('node:fs')
      let text = ''
      try { text = fs.readFileSync(cfg.recordsPath, 'utf8') } catch { /* none */ }
      const findings = parseNdjson(text, { ...cfg, minSeverity: 'info' })
      const bySeverity = {}
      const byRule = {}
      const byAgent = {}
      for (const f of findings) {
        bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
        if (f.ruleId) byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1
        if (f.agent) byAgent[f.agent] = (byAgent[f.agent] ?? 0) + 1
      }
      return { total: findings.length, bySeverity, byRule, byAgent, recordsPath: cfg.recordsPath }
    }, log),
  })

  registerTrigger({
    name: 'numbat_finding',
    description: 'Fires when a Numbat detection (finding/enforcement/indicator, or high-severity event) is ingested. Use to auto-remediate: isolate the host, kill the agent, open an incident, or run a playbook.',
    match: (event) => {
      if (event?.source !== 'numbat') return false
      return severityAtLeast(event.severity, 'medium')
    },
    action: 'propose-change',
  })

  registerPanel({
    name: 'numbat-findings',
    title: 'Numbat Findings',
    render: (data) => {
      const rows = (Array.isArray(data) ? data : []).map((f) =>
        `<tr><td>${f.severity ?? ''}</td><td>${f.title ?? ''}</td><td>${f.agent ?? ''}</td><td>${f.host ?? ''}</td></tr>`
      ).join('')
      return `<div class="numbat-findings"><h3>Numbat Findings</h3><p>Records: ${cfg.recordsPath}</p><table><thead><tr><th>Severity</th><th>Title</th><th>Agent</th><th>Host</th></tr></thead><tbody>${rows}</tbody></table></div>`
    },
  })

  log(`[numbat] numbat-bridge registered: 4 tools, 1 trigger, 1 panel (bin=${cfg.binaryPath})`)
}

export default { register, resolveConfig, normalizeRecord, parseNdjson, buildDeployCommand }
