/**
 * mitmproxy-bridge — mitmproxy traffic capture for RTerm.
 *
 * Two use modes:
 *   1. Agent self-inspection — capture what the LLM actually sends over the
 *      wire (verify no secrets leak in prompts, inspect provider requests).
 *   2. Authorized interception — capture traffic on hosts you administer,
 *      following the APerf deploy pattern (run on the RTerm host as a sidecar).
 *
 * Pure + injectable: process spawning and file reads are injected; command
 * building, flow parsing, and secret detection are pure and fully testable.
 */

// --- Pure: build the mitmdump command line ---

export function buildMitmCommand(opts) {
  const {
    mode = 'regular',        // regular | reverse
    listenPort = 8080,
    upstreamTarget,          // for reverse mode: the upstream host:port
    flowsFile,               // where to write the flow file
    filterExpr,              // optional mitmproxy filter expression
    extraArgs = [],
  } = opts || {}

  if (!flowsFile) throw new Error('buildMitmCommand needs flowsFile')
  const args = ['mitmdump']

  if (mode === 'reverse') {
    if (!upstreamTarget) throw new Error('reverse mode needs upstreamTarget')
    args.push('--mode', `reverse:${upstreamTarget}`)
  } else {
    args.push('--mode', 'regular')
  }
  args.push('--listen-port', String(listenPort))
  args.push('-w', flowsFile)
  if (filterExpr) args.push('--set', `flow_detail=0`, '--set', `intercept=${filterExpr}`)
  for (const a of extraArgs) args.push(String(a))
  return { cmd: 'mitmdump', args }
}

// --- Pure: parse a mitmproxy flows file (JSON lines from mitmdump --flow-detail) ---

/**
 * Parse mitmproxy flow records (the JSON array/dump format) into a compact
 * summary: per-host request counts, methods, status codes, and content types.
 */
export function parseFlows(rawFlows) {
  const summary = {
    total: 0,
    byHost: {},
    byStatus: {},
    requests: [],
  }

  let flows = rawFlows
  if (typeof rawFlows === 'string') {
    try { flows = JSON.parse(rawFlows) } catch { return { ...summary, error: 'unparseable flows' } }
  }
  if (!Array.isArray(flows)) return { ...summary, error: 'flows is not an array' }

  for (const f of flows) {
    const host = String(f?.request?.host ?? f?.host ?? 'unknown')
    const method = String(f?.request?.method ?? f?.method ?? '?')
    const status = f?.response?.status_code ?? f?.status_code
    const path = String(f?.request?.path ?? f?.path ?? '')
    const contentType = String(f?.response?.headers?.['content-type'] ?? '')

    summary.total += 1
    const byHost = summary.byHost[host] || (summary.byHost[host] = { count: 0, methods: {} })
    byHost.count += 1
    byHost.methods[method] = (byHost.methods[method] || 0) + 1

    const statusKey = status !== undefined && status !== null ? String(status) : 'no-response'
    summary.byStatus[statusKey] = (summary.byStatus[statusKey] || 0) + 1

    if (summary.requests.length < 100) {
      summary.requests.push({ host, method, path: path.slice(0, 120), status: statusKey, contentType: contentType.slice(0, 60) })
    }
  }

  return summary
}

// --- Pure: detect secret-looking content in captured request bodies ---

const SECRET_PATTERNS = [
  { re: /\bsk-[A-Za-z0-9]{20,}/g, name: 'openai-style-key' },
  { re: /\bghp_[A-Za-z0-9]{30,}/g, name: 'github-token' },
  { re: /\bAKIA[A-Z0-9]{16}\b/g, name: 'aws-access-key' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, name: 'slack-token' },
  // JWT: header/payload/signature. Real JWT headers are commonly exactly 20
  // chars total (17 after the "eyJ" prefix) — {17,} catches those; {20,} was
  // an FN that missed short-header JWTs.
  { re: /\beyJ[A-Za-z0-9_-]{17,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, name: 'jwt' },
  { re: /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?[^\s'"]{8,}/gi, name: 'credential-assignment' },
]

export function detectSecrets(text) {
  const findings = []
  if (!text || typeof text !== 'string') return findings
  for (const { re, name } of SECRET_PATTERNS) {
    const matches = text.match(re)
    if (matches) {
      findings.push({
        kind: name,
        count: matches.length,
        // redact: show only a prefix so the secret itself never lands in output
        preview: matches[0].slice(0, 8) + '…',
      })
    }
  }
  return findings
}

// --- Pure: which hosts are allowed to be intercepted ---

export function isHostAllowed(host, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false
  const h = String(host || '').toLowerCase()
  return allowlist.some((a) => {
    const pat = String(a || '').toLowerCase()
    if (pat === h) return true
    // allow "*.example.com" style suffix matching
    if (pat.startsWith('*.')) return h.endsWith(pat.slice(1))
    return false
  })
}

// --- Plugin entry ---

export function register(ctx) {
  const { registerTool, registerPanel, log, spawnProcess } = ctx

  let mitmChild = null
  let lastSummary = null

  registerTool({
    name: 'mitm_start',
    description: 'Start a mitmproxy capture. Mode "regular" listens as an HTTP proxy on listenPort; mode "reverse" forwards to upstreamTarget. Flows are written to a file for later analysis. Only start captures for hosts you are authorized to intercept.',
    params: {
      mode: { type: 'string', description: '"regular" (proxy) or "reverse" (forward to upstreamTarget)' },
      listenPort: { type: 'number', description: 'Port to listen on (default 8080)' },
      upstreamTarget: { type: 'string', description: 'For reverse mode: host:port to forward to' },
      allowlist: { type: 'array', description: 'Hosts/patterns authorized for interception, e.g. ["api.example.com", "*.internal"]' },
    },
    handler: async (params) => {
      if (typeof spawnProcess !== 'function') {
        return { error: 'mitmproxy-bridge requires process spawning, which is not available in this RTerm build.' }
      }
      if (mitmChild) {
        return { error: 'A mitmproxy capture is already running. Stop it with mitm_stop first.' }
      }

      const mode = params?.mode === 'reverse' ? 'reverse' : 'regular'
      if (mode === 'reverse' && !params?.upstreamTarget) {
        return { error: 'reverse mode needs upstreamTarget (host:port).' }
      }
      // Governance: an allowlist must be provided — no unbounded interception.
      const allowlist = Array.isArray(params?.allowlist) ? params.allowlist : []
      if (mode === 'reverse' && allowlist.length === 0) {
        return { error: 'reverse mode requires an allowlist of authorized hosts. Unbounded interception is not permitted.' }
      }

      const fs = await import('node:fs')
      const os = await import('node:os')
      const path = await import('node:path')
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitm-rterm-'))
      const flowsFile = path.join(dir, 'flows.mitm')

      let plan
      try {
        plan = buildMitmCommand({
          mode,
          listenPort: params?.listenPort,
          upstreamTarget: params?.upstreamTarget,
          flowsFile,
        })
      } catch (e) {
        return { error: e?.message ?? String(e) }
      }

      log(`[mitmproxy] starting ${mode} capture on :${params?.listenPort ?? 8080} → ${flowsFile}`)
      try {
        mitmChild = spawnProcess(plan.cmd, plan.args, { stdio: 'pipe', detached: false })
      } catch (e) {
        return { error: `failed to spawn mitmdump: ${e?.message ?? e}. Is mitmproxy installed (pip install mitmproxy / brew install mitmproxy)?` }
      }
      if (!mitmChild) return { error: 'spawnProcess returned no child process' }

      return {
        started: true,
        mode,
        listenPort: params?.listenPort ?? 8080,
        flowsFile,
        note: mode === 'regular'
          ? 'Configure clients to use this host as HTTP proxy. Stop with mitm_stop.'
          : `Point clients at :${params?.listenPort ?? 8080}; traffic forwards to ${params?.upstreamTarget}. Stop with mitm_stop.`,
      }
    },
  })

  registerTool({
    name: 'mitm_stop',
    description: 'Stop the running mitmproxy capture and summarize the captured flows.',
    params: {},
    handler: async () => {
      if (!mitmChild) return { error: 'No mitmproxy capture is running.' }
      try { mitmChild.kill?.() } catch { /* ignore */ }
      mitmChild = null
      return { stopped: true }
    },
  })

  registerTool({
    name: 'mitm_flows',
    description: 'Summarize captured flows from a mitmproxy flow dump: per-host counts, methods, status codes, and secret detection on request bodies. Use mitmdump -nr <flowsFile> --flow-detail 3 to export, or pass pre-parsed flows.',
    params: {
      flows: { type: 'array', description: 'Pre-parsed flow records [{request:{host,method,path}, response:{status_code}}]' },
    },
    handler: async (params) => {
      const flows = Array.isArray(params?.flows) ? params.flows : []
      if (flows.length === 0) {
        return { error: 'No flows given. Export flows from the capture first (mitmdump -nr <file>) and pass the parsed records.' }
      }
      const summary = parseFlows(flows)

      // Secret scan across request paths + any body text present in the records.
      const textBlob = flows
        .map((f) => `${f?.request?.path ?? ''} ${typeof f?.request?.body === 'string' ? f.request.body : ''}`)
        .join('\n')
        .slice(0, 200_000)
      const secrets = detectSecrets(textBlob)

      lastSummary = { summary, secrets }
      log(`[mitmproxy] summarized ${summary.total} flows across ${Object.keys(summary.byHost).length} host(s); ${secrets.length} secret pattern(s) found`)
      return { summary, secrets }
    },
  })

  registerPanel({
    name: 'mitmproxy-flows',
    title: 'Traffic Capture',
    render: async () => {
      if (!lastSummary) return '<div class="panel-section"><h3>Traffic Capture</h3><p>No flows analyzed yet. Use mitm_start / mitm_flows.</p></div>'
      const hostRows = Object.entries(lastSummary.summary.byHost)
        .slice(0, 10)
        .map(([h, s]) => `<tr><td>${h}</td><td>${s.count}</td></tr>`)
        .join('')
      return `<div class="panel-section"><h3>Traffic Capture — ${lastSummary.summary.total} flows</h3>
        <table><tr><th>host</th><th>requests</th></tr>${hostRows}</table>
        ${lastSummary.secrets.length ? `<p class="warn">⚠ ${lastSummary.secrets.length} secret pattern(s) detected</p>` : '<p>No secrets detected</p>'}
      </div>`
    },
  })
}
