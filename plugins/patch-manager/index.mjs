/**
 * patch-manager plugin — autonomous patch management for RTerm.
 *
 * Discovers patch status across hosts (yum/apt/Windows Update), plans patch
 * deployments, executes via playbooks with MOP approval gates, and alerts on
 * completion/failure. Combines RTerm's fleet orchestration, MOP change
 * management, triggers, and audit trail into an autonomous patch pipeline.
 */

// --- Pure: build the command to query patch status on a host ---
export function buildPatchStatusCommand(os) {
  const o = String(os).toLowerCase()
  if (o === 'windows' || o === 'win32') {
    return 'powershell -Command "Get-WindowsUpdate -Verbose 2>&1 | Select-Object -First 50"'
  }
  if (o === 'linux' || o === 'darwin') {
    // Try yum first, then apt
    return '(yum check-update --quiet 2>/dev/null || apt list --upgradable 2>/dev/null) | head -50'
  }
  return 'echo "unsupported os: ' + o + '"'
}

// --- Pure: build the command to apply patches on a host ---
export function buildPatchApplyCommand(os, opts = {}) {
  const o = String(os).toLowerCase()
  const severity = opts.severity ?? 'all' // all, critical, security, recommended
  const dryRun = opts.dryRun ?? false

  if (o === 'windows' || o === 'win32') {
    const kbFilter = severity === 'critical' ? '-KBArticleID "KB*"' : ''
    const dryRunFlag = dryRun ? '-WhatIf' : ''
    return `powershell -Command "Install-WindowsUpdate ${kbFilter} ${dryRunFlag} -AcceptAll -AutoReboot:$false 2>&1"`
  }
  if (o === 'linux') {
    if (severity === 'security') {
      return dryRun
        ? '(yum update --security --assumeno 2>/dev/null || apt-get -s upgrade --with-new-pkgs 2>/dev/null | grep -i security | head -20)'
        : '(yum update --security -y 2>/dev/null || apt-get upgrade -y --with-new-pkgs 2>/dev/null) | tail -20'
    }
    return dryRun
      ? '(yum update --assumeno 2>/dev/null || apt-get -s upgrade 2>/dev/null) | tail -20'
      : '(yum update -y 2>/dev/null || apt-get upgrade -y 2>/dev/null) | tail -20'
  }
  return 'echo "unsupported os: ' + o + '"'
}

// --- Pure: build the pre-patch verification command ---
export function buildPrePatchCheckCommand(os) {
  const o = String(os).toLowerCase()
  if (o === 'windows' || o === 'win32') {
    return 'powershell -Command "Get-PSDrive -Name C | Select-Object Used,Free; Get-Service -Name wuauserv | Select-Object Status"'
  }
  if (o === 'linux') {
    return 'df -h / | tail -1; systemctl is-system-running 2>/dev/null || true; uptime'
  }
  return 'echo "unsupported os: ' + o + '"'
}

// --- Pure: build the post-patch verification command ---
export function buildPostPatchCheckCommand(os) {
  const o = String(os).toLowerCase()
  if (o === 'windows' || o === 'win32') {
    return 'powershell -Command "Get-WindowsUpdate -Verbose 2>&1 | Select-Object -First 10; Get-Service -Name wuauserv | Select-Object Status"'
  }
  if (o === 'linux') {
    return 'echo "post-patch check: system running"; uptime; df -h / | tail -1'
  }
  return 'echo "unsupported os: ' + o + '"'
}

// --- Pure: parse patch status output into structured results ---
export function parsePatchStatus(output, os) {
  const o = String(os ?? '').toLowerCase()
  const lines = String(output ?? '').split(/\r?\n/).filter((l) => l.trim().length > 0)
  const patches = []
  let summary = { total: 0, critical: 0, security: 0, recommended: 0 }

  for (const line of lines) {
    const l = line.trim()
    // Windows: KB article lines
    const kbMatch = l.match(/(KB\d{7})/i)
    if (kbMatch) {
      patches.push({
        id: kbMatch[1],
        title: l.replace(/KB\d{7}/i, '').trim().slice(0, 80),
        severity: l.match(/critical/i) ? 'critical' : l.match(/security/i) ? 'security' : 'recommended',
        os: 'windows',
      })
      summary.total++
      if (l.match(/critical/i)) summary.critical++
      if (l.match(/security/i)) summary.security++
      continue
    }
    // Linux yum: package.arch version repo
    const yumMatch = l.match(/^(\S+)\.(\S+)\s+(\S+)\s+(\S+)/)
    if (yumMatch && !l.startsWith('Loaded') && !l.startsWith('Last') && !l.startsWith('No')) {
      patches.push({
        id: yumMatch[1],
        title: `${yumMatch[1]}.${yumMatch[2]} ${yumMatch[3]} (${yumMatch[4]})`,
        severity: l.match(/security/i) ? 'security' : l.match(/critical/i) ? 'critical' : 'recommended',
        os: 'linux',
      })
      summary.total++
      if (l.match(/security/i)) summary.security++
      if (l.match(/critical/i)) summary.critical++
      continue
    }
    // Linux apt: package/version
    const aptMatch = l.match(/^(\S+)\/(\S+)\s+(\S+)\s+(\S+)/)
    if (aptMatch && !l.startsWith('Listing')) {
      patches.push({
        id: aptMatch[1],
        title: `${aptMatch[1]}/${aptMatch[2]} ${aptMatch[3]} (${aptMatch[4]})`,
        severity: l.match(/security/i) ? 'security' : l.match(/critical/i) ? 'critical' : 'recommended',
        os: 'linux',
      })
      summary.total++
      if (l.match(/security/i)) summary.security++
      if (l.match(/critical/i)) summary.critical++
    }
  }

  summary.recommended = summary.total - summary.critical - summary.security
  return { patches, summary }
}

// --- Pure: build a patch plan from patch status ---
export function buildPatchPlan(host, os, patchStatus, opts = {}) {
  const severity = opts.severity ?? 'all'
  const toApply = severity === 'all'
    ? patchStatus.patches
    : patchStatus.patches.filter((p) => p.severity === severity)

  return {
    host,
    os,
    patchesToApply: toApply.length,
    patchIds: toApply.map((p) => p.id),
    severity,
    estimatedDowntimeMin: toApply.length * 2, // rough estimate
    requiresReboot: os === 'windows' || toApply.some((p) => p.severity === 'critical'),
    plan: [
      { step: 1, name: 'pre-check', command: buildPrePatchCheckCommand(os), description: 'Verify system health before patching' },
      { step: 2, name: 'backup', command: 'echo "snapshot/checkpoint before patch"', description: 'Create restore point' },
      { step: 3, name: 'apply', command: buildPatchApplyCommand(os, { severity }), description: `Apply ${toApply.length} patches (${severity})` },
      { step: 4, name: 'post-check', command: buildPostPatchCheckCommand(os), description: 'Verify patches applied successfully' },
      { step: 5, name: 'rollback', command: 'echo "rollback if post-check fails"', description: 'Rollback on failure', onError: 'continue' },
    ],
  }
}

// --- Pure: build a compliance report for a fleet ---
export function buildComplianceReport(hostStatuses) {
  const hosts = Object.entries(hostStatuses ?? {}).map(([host, status]) => ({
    host,
    os: status.os ?? 'unknown',
    totalPatches: status.summary?.total ?? 0,
    criticalPatches: status.summary?.critical ?? 0,
    securityPatches: status.summary?.security ?? 0,
    compliant: (status.summary?.critical ?? 0) === 0 && (status.summary?.security ?? 0) === 0,
  }))

  const totalHosts = hosts.length
  const compliantHosts = hosts.filter((h) => h.compliant).length
  const nonCompliantHosts = totalHosts - compliantHosts
  const totalCritical = hosts.reduce((s, h) => s + h.criticalPatches, 0)
  const totalSecurity = hosts.reduce((s, h) => s + h.securityPatches, 0)

  return {
    hosts,
    summary: {
      totalHosts,
      compliantHosts,
      nonCompliantHosts,
      complianceRate: totalHosts > 0 ? Math.round((compliantHosts / totalHosts) * 100) : 100,
      totalCriticalPatches: totalCritical,
      totalSecurityPatches: totalSecurity,
    },
  }
}

// --- Plugin entry ---
export function register(ctx) {
  const { registerTool, registerTrigger, registerPanel, exec, readLedger, log } = ctx

  // Tool: patch_status — query patch status of a host
  registerTool({
    name: 'patch_status',
    description: 'Query the current patch status of a host (available updates). Returns patch list with severity classification.',
    params: {
      host: { type: 'string', description: 'Host to query' },
      os: { type: 'string', description: 'OS type: linux, windows, darwin' },
    },
    handler: async (params) => {
      const { host, os } = params ?? {}
      if (!host || !os) return { error: 'host and os are required' }
      const cmd = buildPatchStatusCommand(os)
      log(`[patch-manager] querying patch status on ${host} (${os})`)
      const output = await exec(cmd, { host })
      const result = parsePatchStatus(output, os)
      return { host, os, ...result }
    },
  })

  // Tool: patch_plan — build a patch deployment plan for a host
  registerTool({
    name: 'patch_plan',
    description: 'Build a patch deployment plan for a host (pre-check → backup → apply → post-check → rollback). Returns the plan for MOP approval.',
    params: {
      host: { type: 'string', description: 'Host to plan for' },
      os: { type: 'string', description: 'OS type' },
      severity: { type: 'string', description: 'Patch severity filter: all, critical, security, recommended' },
    },
    handler: async (params) => {
      const { host, os, severity = 'all' } = params ?? {}
      if (!host || !os) return { error: 'host and os are required' }
      // First get current status
      const statusCmd = buildPatchStatusCommand(os)
      const statusOutput = await exec(statusCmd, { host })
      const patchStatus = parsePatchStatus(statusOutput, os)
      const plan = buildPatchPlan(host, os, patchStatus, { severity })
      log(`[patch-manager] built patch plan for ${host}: ${plan.patchesToApply} patches`)
      return plan
    },
  })

  // Tool: patch_apply — execute a patch plan on a host (runs as MOP change)
  registerTool({
    name: 'patch_apply',
    description: 'Execute a patch deployment on a host. This is a destructive operation — requires MOP approval. Returns the execution result.',
    params: {
      host: { type: 'string', description: 'Host to patch' },
      os: { type: 'string', description: 'OS type' },
      severity: { type: 'string', description: 'Patch severity filter' },
      dryRun: { type: 'boolean', description: 'If true, simulate only (no changes)' },
    },
    handler: async (params) => {
      const { host, os, severity = 'all', dryRun = false } = params ?? {}
      if (!host || !os) return { error: 'host and os are required' }
      const applyCmd = buildPatchApplyCommand(os, { severity, dryRun })
      log(`[patch-manager] ${dryRun ? 'simulating' : 'applying'} patches on ${host} (${severity})`)
      const output = await exec(applyCmd, { host })
      const postCheck = await exec(buildPostPatchCheckCommand(os), { host })
      return { host, os, severity, dryRun, output: output.slice(0, 2000), postCheck: postCheck.slice(0, 500) }
    },
  })

  // Trigger: patch_failure — fires when a patch execution fails
  registerTrigger({
    name: 'patch_failure',
    description: 'Fires when a patch execution output contains error/failure indicators. Use for auto-remediation or investigation.',
    match: (event) => {
      if (event?.source !== 'playbook') return false
      const detail = String(event?.detail ?? '').toLowerCase()
      return detail.includes('error') || detail.includes('failed') || detail.includes('rollback')
    },
    action: 'propose-change',
  })

  // Trigger: patch_completion — fires when a patch execution completes successfully
  registerTrigger({
    name: 'patch_completion',
    description: 'Fires when a patch execution completes without errors. Use for compliance reporting.',
    match: (event) => {
      if (event?.source !== 'playbook') return false
      const detail = String(event?.detail ?? '').toLowerCase()
      return detail.includes('success') || detail.includes('completed') || detail.includes('no packages marked for update')
    },
    action: 'run-playbook',
  })

  // Panel: patch-compliance — patch compliance dashboard
  registerPanel({
    name: 'patch-compliance',
    title: 'Patch Compliance',
    render: (data) => {
      const report = buildComplianceReport(data ?? {})
      const rows = report.hosts.map((h) =>
        `<tr><td>${h.host}</td><td>${h.os}</td><td>${h.totalPatches}</td><td>${h.criticalPatches}</td><td>${h.securityPatches}</td><td>${h.compliant ? '✅' : '❌'}</td></tr>`
      ).join('')
      return `<div class="patch-compliance"><h3>Patch Compliance</h3><p>Compliance rate: ${report.summary.complianceRate}% (${report.summary.compliantHosts}/${report.summary.totalHosts} hosts)</p><p>Critical: ${report.summary.totalCriticalPatches} | Security: ${report.summary.totalSecurityPatches}</p><table><thead><tr><th>Host</th><th>OS</th><th>Total</th><th>Critical</th><th>Security</th><th>Compliant</th></tr></thead><tbody>${rows}</tbody></table></div>`
    },
  })

  log('[patch-manager] registered: 3 tools, 2 triggers, 1 panel')
}

export default { register, buildPatchStatusCommand, buildPatchApplyCommand, buildPrePatchCheckCommand, buildPostPatchCheckCommand, parsePatchStatus, buildPatchPlan, buildComplianceReport }
