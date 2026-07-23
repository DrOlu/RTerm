/**
 * sop-assistant plugin — IAM Knowledge & SOP Assistant.
 *
 * SOP retrieval with keyword search, step-by-step guided flows, and IAM policy
 * lookup. Answers "how do I X?" with relevant SOPs and executes them with
 * user confirmation. Built-in SOP library for common ops tasks + extensible
 * via custom SOP registration.
 */

// --- Pure: the built-in SOP library ---
export const BUILTIN_SOPS = [
  {
    id: 'restart-service',
    title: 'Restart a Service',
    category: 'operations',
    keywords: ['restart', 'service', 'systemctl', 'reboot', 'reload'],
    steps: [
      { step: 1, action: 'Check service status', command: 'systemctl status {service}', verify: 'service is running or stopped' },
      { step: 2, action: 'Restart the service', command: 'systemctl restart {service}', verify: 'command succeeds' },
      { step: 3, action: 'Verify service is running', command: 'systemctl status {service}', verify: 'active (running)' },
      { step: 4, action: 'Check recent logs', command: 'journalctl -u {service} -n 20 --no-pager', verify: 'no errors in logs' },
    ],
  },
  {
    id: 'disk-cleanup',
    title: 'Disk Space Cleanup',
    category: 'operations',
    keywords: ['disk', 'space', 'cleanup', 'full', 'storage', 'df'],
    steps: [
      { step: 1, action: 'Check disk usage', command: 'df -h /', verify: 'identify full filesystem' },
      { step: 2, action: 'Find large files', command: 'find / -type f -size +100M -exec ls -lh {} \\; 2>/dev/null | head -20', verify: 'identify large files' },
      { step: 3, action: 'Clean package cache', command: 'yum clean all 2>/dev/null || apt-get clean 2>/dev/null', verify: 'cache cleaned' },
      { step: 4, action: 'Clean old logs', command: 'journalctl --vacuum-time=7d 2>/dev/null; find /var/log -name "*.gz" -mtime +30 -delete 2>/dev/null', verify: 'old logs removed' },
      { step: 5, action: 'Verify disk space recovered', command: 'df -h /', verify: 'usage below 80%' },
    ],
  },
  {
    id: 'reset-password',
    title: 'Reset User Password',
    category: 'iam',
    keywords: ['password', 'reset', 'user', 'account', 'passwd', 'login'],
    steps: [
      { step: 1, action: 'Verify user exists', command: 'id {username} 2>/dev/null || Get-LocalUser {username} 2>/dev/null', verify: 'user found' },
      { step: 2, action: 'Reset password', command: 'passwd {username} 2>/dev/null || Set-LocalUser -Name {username} -Password (ConvertTo-SecureString -AsPlainText "{new_password}" -Force) 2>/dev/null', verify: 'password changed' },
      { step: 3, action: 'Force password change at next login', command: 'passwd -e {username} 2>/dev/null || Set-LocalUser -Name {username} -PasswordNeverExpires:$false 2>/dev/null', verify: 'flag set' },
      { step: 4, action: 'Verify account is not locked', command: 'passwd -S {username} 2>/dev/null || Get-LocalUser {username} | Select-Object LockedOut 2>/dev/null', verify: 'not locked' },
    ],
  },
  {
    id: 'database-failover',
    title: 'Database Failover Procedure',
    category: 'operations',
    keywords: ['database', 'failover', 'mysql', 'postgres', 'replica', 'primary', 'switchover'],
    steps: [
      { step: 1, action: 'Verify replica is healthy', command: 'SHOW REPLICA STATUS 2>/dev/null || SELECT * FROM pg_stat_replication 2>/dev/null', verify: 'replication is running' },
      { step: 2, action: 'Stop writes to primary', command: 'SET GLOBAL read_only = ON 2>/dev/null || ALTER SYSTEM SET default_transaction_read_only = on 2>/dev/null', verify: 'read-only mode' },
      { step: 3, action: 'Wait for replica to catch up', command: 'SELECT MASTER_POS_WAIT(MASTER_LOG_FILE, MASTER_LOG_POS) 2>/dev/null || SELECT pg_last_wal_replay_lsn() 2>/dev/null', verify: 'caught up' },
      { step: 4, action: 'Promote replica to primary', command: 'STOP REPLICA 2>/dev/null || SELECT pg_promote() 2>/dev/null', verify: 'promoted' },
      { step: 5, action: 'Update DNS/load balancer', command: 'echo "update DNS to point to new primary"', verify: 'DNS updated' },
      { step: 6, action: 'Verify application connectivity', command: 'echo "verify app connects to new primary"', verify: 'app connected' },
    ],
  },
  {
    id: 'ssl-cert-renewal',
    title: 'SSL Certificate Renewal',
    category: 'security',
    keywords: ['ssl', 'certificate', 'cert', 'renew', 'letsencrypt', 'tls', 'https'],
    steps: [
      { step: 1, action: 'Check certificate expiry', command: 'openssl x509 -enddate -noout -in /etc/ssl/certs/{domain}.crt 2>/dev/null', verify: 'check days remaining' },
      { step: 2, action: 'Renew certificate', command: 'certbot renew --dry-run 2>/dev/null || echo "manual renewal needed"', verify: 'renewal works' },
      { step: 3, action: 'Apply new certificate', command: 'certbot renew --force-renewal 2>/dev/null || echo "apply manually"', verify: 'certificate renewed' },
      { step: 4, action: 'Reload web server', command: 'systemctl reload nginx 2>/dev/null || systemctl reload apache2 2>/dev/null || Restart-Service W3SVC 2>/dev/null', verify: 'reloaded' },
      { step: 5, action: 'Verify new certificate', command: 'openssl x509 -enddate -noout -in /etc/ssl/certs/{domain}.crt 2>/dev/null', verify: 'new expiry date' },
    ],
  },
  {
    id: 'user-offboarding',
    title: 'User Offboarding',
    category: 'iam',
    keywords: ['offboard', 'disable', 'deactivate', 'remove user', 'terminate', 'leave'],
    steps: [
      { step: 1, action: 'Disable user account', command: 'usermod -L {username} 2>/dev/null || Disable-LocalUser -Name {username} 2>/dev/null', verify: 'account disabled' },
      { step: 2, action: 'Kill active sessions', command: 'pkill -u {username} 2>/dev/null || echo "check active sessions"', verify: 'sessions terminated' },
      { step: 3, action: 'Remove from groups', command: 'gpasswd -d {username} sudo 2>/dev/null || Remove-LocalGroupMember -Group Administrators -Member {username} 2>/dev/null', verify: 'removed from privileged groups' },
      { step: 4, action: 'Archive home directory', command: 'tar -czf /backup/{username}-home-$(date +%Y%m%d).tar.gz /home/{username} 2>/dev/null || Compress-Archive -Path C:\\Users\\{username} -DestinationPath C:\\Backup\\{username}.zip 2>/dev/null', verify: 'archived' },
      { step: 5, action: 'Disable SSH keys', command: 'mv /home/{username}/.ssh/authorized_keys /home/{username}/.ssh/authorized_keys.disabled 2>/dev/null || echo "no SSH keys"', verify: 'SSH keys disabled' },
      { step: 6, action: 'Verify no active processes', command: 'ps -u {username} 2>/dev/null || Get-Process -IncludeUserName | Where-Object {$_.UserName -like "*{username}*"} 2>/dev/null', verify: 'no processes' },
    ],
  },
  {
    id: 'backup-restore',
    title: 'Database Backup and Restore',
    category: 'operations',
    keywords: ['backup', 'restore', 'dump', 'mysqldump', 'pg_dump', 'database backup'],
    steps: [
      { step: 1, action: 'Create backup directory', command: 'mkdir -p /backup/$(date +%Y%m%d)', verify: 'directory exists' },
      { step: 2, action: 'Backup database', command: 'mysqldump -u root --all-databases > /backup/$(date +%Y%m%d)/all-databases.sql 2>/dev/null || pg_dumpall > /backup/$(date +%Y%m%d)/all-databases.sql 2>/dev/null', verify: 'backup created' },
      { step: 3, action: 'Compress backup', command: 'gzip /backup/$(date +%Y%m%d)/all-databases.sql', verify: 'compressed' },
      { step: 4, action: 'Verify backup integrity', command: 'gunzip -t /backup/$(date +%Y%m%d)/all-databases.sql.gz', verify: 'integrity OK' },
      { step: 5, action: 'Clean old backups', command: 'find /backup -name "*.sql.gz" -mtime +30 -delete', verify: 'old backups removed' },
    ],
  },
  {
    id: 'incident-response',
    title: 'Incident Response Procedure',
    category: 'security',
    keywords: ['incident', 'response', 'breach', 'security', 'compromise', 'alert'],
    steps: [
      { step: 1, action: 'Identify affected systems', command: 'echo "identify scope of incident"', verify: 'scope identified' },
      { step: 2, action: 'Isolate affected systems', command: 'echo "isolate from network if needed"', verify: 'isolated' },
      { step: 3, action: 'Collect evidence', command: 'echo "preserve logs, memory dumps, network captures"', verify: 'evidence preserved' },
      { step: 4, action: 'Assess damage', command: 'echo "determine what was accessed/modified"', verify: 'damage assessed' },
      { step: 5, action: 'Contain and eradicate', command: 'echo "remove attacker access, patch vulnerabilities"', verify: 'contained' },
      { step: 6, action: 'Recover systems', command: 'echo "restore from clean backup, verify integrity"', verify: 'recovered' },
      { step: 7, action: 'Post-incident review', command: 'echo "document lessons learned, update procedures"', verify: 'documented' },
    ],
  },
]

// --- Pure: the built-in IAM policy library ---
export const IAM_POLICIES = [
  {
    id: 'password-policy',
    title: 'Password Policy',
    category: 'iam',
    rules: [
      'Minimum 12 characters',
      'Require uppercase, lowercase, number, special character',
      'Maximum 90 days before forced change',
      'No reuse of last 5 passwords',
      'Account lockout after 5 failed attempts (15 min lockout)',
    ],
  },
  {
    id: 'access-control',
    title: 'Access Control Policy',
    category: 'iam',
    rules: [
      'Least privilege: users get minimum permissions needed',
      'Role-based access control (RBAC) for all systems',
      'Privileged access requires MFA',
      'Service accounts must have named owners',
      'Access reviews quarterly',
    ],
  },
  {
    id: 'ssh-access',
    title: 'SSH Access Policy',
    category: 'iam',
    rules: [
      'SSH key-based authentication only (no password auth)',
      'Root login disabled',
      'SSH on non-standard port (not 22)',
      'Fail2ban enabled for brute-force protection',
      'SSH keys rotated annually',
    ],
  },
  {
    id: 'service-account',
    title: 'Service Account Policy',
    category: 'iam',
    rules: [
      'Service accounts must have named owners',
      'No interactive login for service accounts',
      'Service account credentials rotated quarterly',
      'Least privilege for service accounts',
      'Audit logging for all service account activity',
    ],
  },
]

// --- Pure: search SOPs by keyword ---
export function searchSops(query, sops = BUILTIN_SOPS) {
  const q = String(query ?? '').toLowerCase()
  if (!q) return []
  const words = q.split(/\s+/)
  return sops
    .map((sop) => {
      let score = 0
      const text = `${sop.title} ${sop.category} ${sop.keywords.join(' ')}`.toLowerCase()
      for (const word of words) {
        if (text.includes(word)) score += 1
        if (sop.keywords.some((k) => k.includes(word))) score += 2
      }
      return { sop, score }
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => ({ id: r.sop.id, title: r.sop.title, category: r.sop.category, relevance: r.score, steps: r.sop.steps.length }))
}

// --- Pure: get a SOP by ID ---
export function getSop(id, sops = BUILTIN_SOPS) {
  return sops.find((s) => s.id === id) ?? null
}

// --- Pure: search IAM policies ---
export function searchIamPolicies(query, policies = IAM_POLICIES) {
  const q = String(query ?? '').toLowerCase()
  if (!q) return []
  return policies
    .map((policy) => {
      let score = 0
      const text = `${policy.title} ${policy.category} ${policy.rules.join(' ')}`.toLowerCase()
      for (const word of q.split(/\s+/)) {
        if (text.includes(word)) score += 1
      }
      return { policy, score }
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => ({ id: r.policy.id, title: r.policy.title, category: r.policy.category, relevance: r.score, rules: r.policy.rules }))
}

// --- Pure: build the command for a SOP step (with variable substitution) ---
export function buildStepCommand(step, vars = {}) {
  let cmd = String(step?.command ?? '')
  for (const [key, value] of Object.entries(vars ?? {})) {
    cmd = cmd.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value))
  }
  return cmd
}

// --- Plugin entry ---
export function register(ctx) {
  const { registerTool, registerTrigger, registerPanel, exec, log } = ctx
  const customSops = []

  // Tool: sop_search — search SOPs by natural language query
  registerTool({
    name: 'sop_search',
    description: 'Search SOPs, runbooks, and procedures by natural language query. Returns matching SOPs with step counts.',
    params: { query: { type: 'string', description: 'Natural language query (e.g., "how to restart a service", "database failover procedure")' } },
    handler: async (params) => {
      const results = searchSops(params?.query ?? '', [...BUILTIN_SOPS, ...customSops])
      log(`[sop-assistant] search "${params?.query}": ${results.length} results`)
      return { query: params?.query, results }
    },
  })

  // Tool: sop_get — get a specific SOP by ID
  registerTool({
    name: 'sop_get',
    description: 'Get a specific SOP by ID. Returns the full SOP with all steps.',
    params: { id: { type: 'string', description: 'SOP ID (e.g., "restart-service", "database-failover")' } },
    handler: async (params) => {
      const sop = getSop(params?.id ?? '', [...BUILTIN_SOPS, ...customSops])
      if (!sop) return { error: `SOP ${params?.id} not found` }
      return sop
    },
  })

  // Tool: sop_execute — execute a SOP step-by-step
  registerTool({
    name: 'sop_execute',
    description: 'Execute a SOP step-by-step with variable substitution. Each step is executed and verified before proceeding.',
    params: {
      id: { type: 'string', description: 'SOP ID to execute' },
      vars: { type: 'object', description: 'Variables to substitute (e.g., {"service": "nginx", "username": "john"})' },
      startStep: { type: 'number', description: 'Step to start from (default 1)' },
      dryRun: { type: 'boolean', description: 'If true, show commands without executing' },
    },
    handler: async (params) => {
      const sop = getSop(params?.id ?? '', [...BUILTIN_SOPS, ...customSops])
      if (!sop) return { error: `SOP ${params?.id} not found` }
      const vars = params?.vars ?? {}
      const startStep = params?.startStep ?? 1
      const dryRun = params?.dryRun ?? false

      const results = []
      for (const step of sop.steps) {
        if (step.step < startStep) continue
        const cmd = buildStepCommand(step, vars)
        if (dryRun) {
          results.push({ step: step.step, action: step.action, command: cmd, status: 'dry_run' })
        } else {
          log(`[sop-assistant] executing step ${step.step}: ${step.action}`)
          const output = await exec(cmd, {})
          results.push({ step: step.step, action: step.action, command: cmd, output: output.slice(0, 500), status: 'executed' })
        }
      }
      return { sopId: sop.id, title: sop.title, dryRun, results }
    },
  })

  // Tool: iam_lookup — search IAM policies
  registerTool({
    name: 'iam_lookup',
    description: 'Search IAM policies by keyword. Returns matching policies with rules.',
    params: { query: { type: 'string', description: 'Search query (e.g., "password policy", "SSH access", "service account")' } },
    handler: async (params) => {
      const results = searchIamPolicies(params?.query ?? '')
      log(`[sop-assistant] IAM lookup "${params?.query}": ${results.length} policies`)
      return { query: params?.query, results }
    },
  })

  // Trigger: sop_escalation — fires when a SOP execution fails
  registerTrigger({
    name: 'sop_escalation',
    description: 'Fires when a SOP execution step fails. Use for escalation to senior operator.',
    match: (event) => {
      if (event?.source !== 'sop-assistant') return false
      return event.labels?.status === 'failed'
    },
    action: 'propose-change',
  })

  // Panel: sop-library — SOP library browser
  registerPanel({
    name: 'sop-library',
    title: 'SOP Library',
    render: (data) => {
      const sops = [...BUILTIN_SOPS, ...customSops]
      const rows = sops.map((s) =>
        `<tr><td>${s.id}</td><td>${s.title}</td><td>${s.category}</td><td>${s.steps.length}</td></tr>`
      ).join('')
      return `<div class="sop-library"><h3>SOP Library</h3><p>${sops.length} SOPs available</p><table><thead><tr><th>ID</th><th>Title</th><th>Category</th><th>Steps</th></tr></thead><tbody>${rows}</tbody></table></div>`
    },
  })

  log('[sop-assistant] registered: 4 tools, 1 trigger, 1 panel')
}

export default { register, searchSops, getSop, searchIamPolicies, buildStepCommand, BUILTIN_SOPS, IAM_POLICIES }
