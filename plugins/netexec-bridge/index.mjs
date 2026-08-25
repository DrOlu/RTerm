/**
 * netexec-bridge — NetExec external attack-simulation for RTerm.
 *
 * Complements rmagent (which watches FROM the boxes) by testing FROM the
 * outside: credential validation, SMB/LDAP enumeration, spray simulation.
 * The purple-team loop: NetExec stages an external attack, rmagent's attest
 * must catch the resulting 4625s — the drill then scores both halves.
 *
 * GOVERNANCE (non-negotiable):
 *   - Target allowlist required on every call. No unbounded scanning.
 *   - Targets must be hosts the operator administers (same rule as rmagent).
 *   - Credential sprays are rate-limited and jittered by default.
 *   - The plugin never stores credentials; they resolve from the vault/env.
 *
 * Pure + injectable: process spawning injected; command building and output
 * parsing are pure and fully testable.
 */

// --- Pure: build the netexec command line ---

export function buildNetexecCommand(opts) {
  const {
    protocol,        // smb | ldap | winrm | mssql | ssh | ftp | rdp | wmi
    targets,         // string: CIDR, range, or comma-separated hosts
    action,          // netexec subcommand: users, groups, shares, --sam, etc.
    extraArgs = [],
    username,
    passwordRef,     // vault key — never the password itself
    domain,
    timeoutSec = 120,
  } = opts || {}

  if (!protocol) throw new Error('buildNetexecCommand needs a protocol (smb, ldap, winrm, ...)')
  if (!targets) throw new Error('buildNetexecCommand needs targets')
  if (!action) throw new Error('buildNetexecCommand needs an action')

  const args = ['netexec', protocol, String(targets)]
  if (username) args.push('-u', String(username))
  // password resolves at runtime from the vault — we pass an env var name
  if (passwordRef) args.push('-p', `env:${passwordRef}`)
  if (domain) args.push('-d', String(domain))
  args.push('--timeout', String(timeoutSec))
  const actionStr = String(action)
  if (actionStr.startsWith('--')) args.push(actionStr)
  else args.push(actionStr)
  for (const a of extraArgs) args.push(String(a))

  return { cmd: 'netexec', args }
}

// --- Pure: validate targets against the authorized allowlist ---

export function validateTargets(targets, allowlist) {
  if (!targets || typeof targets !== 'string') {
    return { ok: false, reason: 'targets must be a string (CIDR, range, or comma-separated hosts)' }
  }
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return { ok: false, reason: 'an authorized target allowlist is required — unbounded scanning is not permitted' }
  }

  const requested = targets.split(',').map((t) => t.trim()).filter(Boolean)
  const allowedSet = new Set(allowlist.map((a) => String(a).trim()))
  const denied = []

  for (const t of requested) {
    // exact host match
    if (allowedSet.has(t)) continue
    // CIDR membership: allowlist entry is a CIDR and target is a bare IP
    const inCidr = allowlist.some((a) => {
      const cidr = String(a).trim()
      if (!cidr.includes('/')) return false
      return ipInCidr(t, cidr)
    })
    if (inCidr) continue
    denied.push(t)
  }

  if (denied.length > 0) {
    return { ok: false, reason: `target(s) not in the authorized allowlist: ${denied.join(', ')}` }
  }
  return { ok: true, targets: requested }
}

function ipInCidr(ip, cidr) {
  const [base, bitsStr] = cidr.split('/')
  const bits = Number(bitsStr)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const toInt = (s) => {
    const parts = s.split('.').map(Number)
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  }
  const ipInt = toInt(ip)
  const baseInt = toInt(base)
  if (ipInt === null || baseInt === null) return false
  if (bits === 0) return true
  const mask = (0xFFFFFFFF << (32 - bits)) >>> 0
  return (ipInt & mask) === (baseInt & mask)
}

// --- Pure: parse netexec output ---

/**
 * netexec prints lines like:
 *   SMB  192.168.1.10  445  HOSTNAME  [+] hostname\user (Pwn3d!)
 *   SMB  192.168.1.11  445  HOSTNAME2 [-] hostname\user:BADPW
 * Parse into hosts + auth results.
 */
export function parseNetexecOutput(raw) {
  const result = {
    hosts: [],
    authSuccess: [],
    authFailed: [],
    errors: [],
    raw: typeof raw === 'string' ? raw.slice(0, 5000) : '',
  }

  if (typeof raw !== 'string') return result
  const lines = raw.split('\n')

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Host status line: PROTOCOL  ip  port  hostname  [status]
    const m = trimmed.match(/^(\w+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) {
      if (/error|failed to|traceback/i.test(trimmed)) result.errors.push(trimmed.slice(0, 200))
      continue
    }

    const [, proto, ip, port, hostname, rest] = m
    const entry = { protocol: proto, ip, port: Number(port), hostname, detail: rest.slice(0, 200) }

    if (/\[\+\]/.test(rest)) {
      result.authSuccess.push({ ...entry, pwned: /\(Pwn3d!?\)/.test(rest) })
      result.hosts.push({ ip, hostname, status: 'auth-ok' })
    } else if (/\[-\]/.test(rest)) {
      result.authFailed.push(entry)
      result.hosts.push({ ip, hostname, status: 'auth-failed' })
    } else if (/\[\*\]/.test(rest)) {
      result.hosts.push({ ip, hostname, status: 'info', detail: rest.slice(0, 120) })
    } else {
      result.hosts.push({ ip, hostname, status: 'unknown' })
    }
  }

  return result
}

// --- Pure: build a spray plan (rate-limited, jittered) ---

export function buildSprayPlan(opts) {
  const {
    targets,
    usernames,       // array of usernames to try
    attemptsPerUser = 1,
    delayMs = 5000,  // between attempts — slow by default
    jitterMs = 2000,
  } = opts || {}

  if (!Array.isArray(usernames) || usernames.length === 0) {
    throw new Error('buildSprayPlan needs usernames')
  }
  if (!targets) throw new Error('buildSprayPlan needs targets')

  const plan = []
  for (const user of usernames) {
    for (let i = 0; i < Math.max(1, attemptsPerUser); i++) {
      const jitter = Math.floor(Math.random() * Math.max(0, jitterMs))
      plan.push({
        username: String(user),
        attempt: i + 1,
        waitBeforeMs: delayMs + jitter,
      })
    }
  }
  return {
    targets: String(targets),
    steps: plan,
    totalAttempts: plan.length,
    note: `Spray plan: ${plan.length} attempt(s) across ${usernames.length} user(s), ≥${delayMs}ms between attempts (jitter ${jitterMs}ms). This is a SLOW spray by design — verify rmagent attest catches the 4625s.`,
  }
}

// --- Plugin entry ---

export function register(ctx) {
  const { registerTool, registerTrigger, registerPanel, log, spawnProcess } = ctx

  let lastResult = null

  const runNetexec = async (plan) => {
    if (typeof spawnProcess !== 'function') {
      return { error: 'netexec-bridge requires process spawning, which is not available in this RTerm build.' }
    }
    return await new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let child
      try {
        child = spawnProcess(plan.cmd, plan.args, { stdio: 'pipe' })
      } catch (e) {
        resolve({ error: `failed to spawn netexec: ${e?.message ?? e}. Install with: pip install netexec` })
        return
      }
      if (!child || typeof child.on !== 'function') {
        resolve({ error: 'spawnProcess returned no child process' })
        return
      }
      let settled = false
      const settle = (v) => { if (!settled) { settled = true; resolve(v) } }
      child.stdout?.on?.('data', (d) => { stdout += String(d) })
      child.stderr?.on?.('data', (d) => { stderr += String(d) })
      child.on('error', (e) => settle({ error: `netexec spawn error: ${e?.message ?? e}` }))
      child.on('close', (code) => settle({ code, stdout, stderr }))
      const t = setTimeout(() => {
        try { child.kill?.() } catch { /* ignore */ }
        settle({ error: 'netexec timed out', stdout, stderr })
      }, 300_000)
      child.on('close', () => clearTimeout(t))
    })
  }

  registerTool({
    name: 'netexec_check',
    description: 'Run a NetExec check against authorized targets (credential validation, enumeration). Targets MUST be in the authorized allowlist — the same hosts you administer. Results parse into per-host auth outcomes; successful auths are findings.',
    params: {
      protocol: { type: 'string', description: 'smb | ldap | winrm | mssql | ssh | ftp | rdp | wmi' },
      targets: { type: 'string', description: 'Target hosts (comma-separated IPs or a CIDR). Must be within the authorized allowlist.' },
      action: { type: 'string', description: 'NetExec action: users, groups, shares, --sam, --users, etc.' },
      allowlist: { type: 'array', description: 'Authorized target hosts/CIDRs. REQUIRED — no unbounded scanning.' },
      username: { type: 'string', description: 'Username to test' },
      passwordRef: { type: 'string', description: 'Vault key holding the password (never the password itself)' },
      domain: { type: 'string', description: 'Optional domain' },
    },
    handler: async (params) => {
      const { protocol, targets, action } = params || {}
      const allowlist = Array.isArray(params?.allowlist) ? params.allowlist : []

      // Governance gate FIRST.
      const check = validateTargets(targets, allowlist)
      if (!check.ok) {
        return { error: `Authorization failed: ${check.reason}. Only test hosts you administer.` }
      }

      let plan
      try {
        plan = buildNetexecCommand({
          protocol, targets, action,
          username: params?.username,
          passwordRef: params?.passwordRef,
          domain: params?.domain,
        })
      } catch (e) {
        return { error: e?.message ?? String(e) }
      }

      log(`[netexec] ${protocol} ${action} against ${check.targets.length} authorized target(s)`)
      const run = await runNetexec(plan)
      if (run?.error) return { error: run.error, stderr: run.stderr?.slice(0, 400) }

      const parsed = parseNetexecOutput(run.stdout)
      lastResult = parsed

      log(`[netexec] ${parsed.hosts.length} host(s), ${parsed.authSuccess.length} auth success, ${parsed.authFailed.length} auth failed`)
      return {
        hosts: parsed.hosts,
        authSuccess: parsed.authSuccess,
        authFailed: parsed.authFailed,
        errors: parsed.errors,
        note: parsed.authSuccess.length > 0
          ? '⚠ Successful authentication found — treat as a finding and verify rmagent attest saw the corresponding logons.'
          : 'No successful authentications.',
      }
    },
  })

  registerTool({
    name: 'netexec_spray_plan',
    description: 'Build a rate-limited, jittered credential-spray plan (does NOT execute it). Returns the step schedule to review before running via netexec_check. Slow by design so rmagent attest can catch the 4625 pattern.',
    params: {
      targets: { type: 'string', description: 'Target hosts (must be authorized)' },
      usernames: { type: 'array', description: 'Usernames to try' },
      attemptsPerUser: { type: 'number', description: 'Attempts per username (default 1)' },
    },
    handler: async (params) => {
      try {
        const plan = buildSprayPlan({
          targets: params?.targets,
          usernames: params?.usernames,
          attemptsPerUser: params?.attemptsPerUser,
        })
        return plan
      } catch (e) {
        return { error: e?.message ?? String(e) }
      }
    },
  })

  registerTrigger({
    name: 'netexec_auth_success',
    description: 'Fires when a NetExec check finds a successful authentication on an authorized target. Use for incident + rmagent correlation playbooks.',
    match: (event) => {
      if (event?.source !== 'netexec') return false
      return Array.isArray(event?.authSuccess) && event.authSuccess.length > 0
    },
    action: 'run-playbook',
  })

  registerPanel({
    name: 'netexec-results',
    title: 'NetExec',
    render: async () => {
      if (!lastResult) return '<div class="panel-section"><h3>NetExec</h3><p>No check run yet. Use netexec_check.</p></div>'
      const rows = lastResult.hosts.slice(0, 15)
        .map((h) => `<tr><td>${h.ip}</td><td>${h.hostname}</td><td>${h.status}</td></tr>`)
        .join('')
      return `<div class="panel-section"><h3>NetExec — ${lastResult.hosts.length} host(s)</h3>
        <table><tr><th>ip</th><th>hostname</th><th>status</th></tr>${rows}</table>
        ${lastResult.authSuccess.length ? `<p class="warn">⚠ ${lastResult.authSuccess.length} successful auth(s)</p>` : ''}
      </div>`
    },
  })
}
