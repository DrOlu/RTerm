/**
 * v2.7.3 plugin suite — regression tests for patch-manager, request-router,
 * sop-assistant, iam-connector, and fraudops plugins.
 */
import { register as patchRegister, buildPatchStatusCommand, buildPatchApplyCommand, buildPrePatchCheckCommand, parsePatchStatus, buildPatchPlan, buildComplianceReport } from '../../../../../plugins/patch-manager/index.mjs'
import { register as requestRegister, classifyRequest, routeRequest, buildQueueEntry, filterQueue } from '../../../../../plugins/request-router/index.mjs'
import { register as sopRegister, searchSops, getSop, searchIamPolicies, buildStepCommand, BUILTIN_SOPS, IAM_POLICIES } from '../../../../../plugins/sop-assistant/index.mjs'
import { register as iamRegister, buildUserInfoCommand, buildDisableUserCommand, parseUserInfo, isPrivileged } from '../../../../../plugins/iam-connector/index.mjs'
import { register as fraudopsRegister, buildPipelineHealthCommand, parsePipelineHealth, buildStrCase, buildDecisionSummary } from '../../../../../plugins/fraudops/index.mjs'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

// ========== PATCH MANAGER ==========
test('patch: buildPatchStatusCommand for linux', () => {
  const cmd = buildPatchStatusCommand('linux')
  if (!cmd.includes('yum') || !cmd.includes('apt')) throw new Error('should include yum/apt')
})
test('patch: buildPatchStatusCommand for windows', () => {
  const cmd = buildPatchStatusCommand('windows')
  if (!cmd.includes('Get-WindowsUpdate')) throw new Error('should include Get-WindowsUpdate')
})
test('patch: buildPatchApplyCommand for linux with security severity', () => {
  const cmd = buildPatchApplyCommand('linux', { severity: 'security' })
  if (!cmd.includes('--security')) throw new Error('should include --security')
})
test('patch: buildPatchApplyCommand with dryRun', () => {
  const cmd = buildPatchApplyCommand('linux', { dryRun: true })
  if (!cmd.includes('assumeno') && !cmd.includes('-s upgrade')) throw new Error('should be dry-run')
})
test('patch: buildPrePatchCheckCommand for linux', () => {
  const cmd = buildPrePatchCheckCommand('linux')
  if (!cmd.includes('df -h')) throw new Error('should include df')
})
test('patch: parsePatchStatus parses yum output', () => {
  const output = 'kernel.x86_64  5.14.0-362.el9  updates\nopenssl.x86_64  3.0.7-18.el9_2  updates'
  const { patches, summary } = parsePatchStatus(output, 'linux')
  if (patches.length !== 2) throw new Error(`expected 2 patches, got ${patches.length}`)
  if (summary.total !== 2) throw new Error('summary total')
})
test('patch: parsePatchStatus parses Windows KB output', () => {
  const output = 'KB5034441 Security Update for Windows Server 2022'
  const { patches } = parsePatchStatus(output, 'windows')
  if (patches.length !== 1) throw new Error(`expected 1 patch, got ${patches.length}`)
  if (patches[0].id !== 'KB5034441') throw new Error('KB id')
})
test('patch: buildPatchPlan creates 5-step plan', () => {
  const status = { patches: [{ id: 'pkg1', severity: 'security' }], summary: { total: 1, critical: 0, security: 1, recommended: 0 } }
  const plan = buildPatchPlan('web-01', 'linux', status)
  if (plan.plan.length !== 5) throw new Error(`expected 5 steps, got ${plan.plan.length}`)
  if (plan.patchesToApply !== 1) throw new Error('patchesToApply')
})
test('patch: buildComplianceReport computes compliance rate', () => {
  const statuses = {
    'web-01': { os: 'linux', summary: { total: 5, critical: 0, security: 0, recommended: 5 } },
    'web-02': { os: 'linux', summary: { total: 3, critical: 1, security: 1, recommended: 1 } },
  }
  const report = buildComplianceReport(statuses)
  if (report.summary.totalHosts !== 2) throw new Error('totalHosts')
  if (report.summary.compliantHosts !== 1) throw new Error('compliantHosts')
  if (report.summary.complianceRate !== 50) throw new Error(`expected 50%, got ${report.summary.complianceRate}%`)
})
test('patch: register registers 3 tools, 2 triggers, 1 panel', () => {
  const tools: any[] = [], triggers: any[] = [], panels: any[] = []
  patchRegister({ registerTool: (t: any) => tools.push(t), registerTrigger: (t: any) => triggers.push(t), registerPanel: (p: any) => panels.push(p), exec: async () => '', readLedger: () => ({}), log: () => {} })
  if (tools.length !== 3) throw new Error(`expected 3 tools, got ${tools.length}`)
  if (triggers.length !== 2) throw new Error(`expected 2 triggers, got ${triggers.length}`)
  if (panels.length !== 1) throw new Error(`expected 1 panel, got ${panels.length}`)
})

// ========== REQUEST ROUTER ==========
test('request: classifyRequest returns high for destructive', () => {
  if (classifyRequest({ type: 'delete database' }) !== 'high') throw new Error('should be high')
})
test('request: classifyRequest returns high for prod restart', () => {
  if (classifyRequest({ type: 'restart', target: 'prod-web-01' }) !== 'high') throw new Error('should be high')
})
test('request: classifyRequest returns medium for restart', () => {
  if (classifyRequest({ type: 'restart', target: 'web-01' }) !== 'medium') throw new Error('should be medium')
})
test('request: classifyRequest returns low for status', () => {
  if (classifyRequest({ type: 'status', target: 'web-01' }) !== 'low') throw new Error('should be low')
})
test('request: routeRequest auto_approves low risk', () => {
  const { route } = routeRequest({ type: 'status', target: 'web-01' })
  if (route !== 'auto_approve') throw new Error('should auto_approve')
})
test('request: routeRequest queues medium risk', () => {
  const { route } = routeRequest({ type: 'restart', target: 'web-01' })
  if (route !== 'queue') throw new Error('should queue')
})
test('request: routeRequest requires MOP for high risk', () => {
  const { route } = routeRequest({ type: 'delete database', target: 'prod-db-01' })
  if (route !== 'mop') throw new Error('should mop')
})
test('request: buildQueueEntry creates entry with correct route', () => {
  const entry = buildQueueEntry({ type: 'restart', target: 'web-01', urgency: 'medium' }, 'req-001')
  if (entry.id !== 'req-001') throw new Error('id')
  if (entry.route !== 'queue') throw new Error('route')
  if (entry.status !== 'pending') throw new Error('status')
})
test('request: filterQueue filters by status', () => {
  const queue = [
    { id: '1', status: 'pending', risk: 'medium', urgency: 'low', target: 'web-01' },
    { id: '2', status: 'approved', risk: 'medium', urgency: 'low', target: 'web-01' },
    { id: '3', status: 'pending', risk: 'low', urgency: 'high', target: 'web-02' },
  ]
  const pending = filterQueue(queue, { status: 'pending' })
  if (pending.length !== 2) throw new Error(`expected 2, got ${pending.length}`)
})
test('request: register registers 4 tools, 2 triggers, 1 panel', () => {
  const tools: any[] = [], triggers: any[] = [], panels: any[] = []
  requestRegister({ registerTool: (t: any) => tools.push(t), registerTrigger: (t: any) => triggers.push(t), registerPanel: (p: any) => panels.push(p), exec: async () => '', readLedger: () => ({}), log: () => {} })
  if (tools.length !== 4) throw new Error(`expected 4 tools, got ${tools.length}`)
  if (triggers.length !== 2) throw new Error(`expected 2 triggers, got ${triggers.length}`)
  if (panels.length !== 1) throw new Error(`expected 1 panel, got ${panels.length}`)
})

// ========== SOP ASSISTANT ==========
test('sop: searchSops finds restart-service', () => {
  const results = searchSops('restart service')
  if (results.length === 0) throw new Error('should find restart-service')
  if (results[0].id !== 'restart-service') throw new Error(`expected restart-service, got ${results[0].id}`)
})
test('sop: searchSops finds disk-cleanup', () => {
  const results = searchSops('disk space cleanup')
  if (results.length === 0) throw new Error('should find disk-cleanup')
})
test('sop: searchSops returns empty for no match', () => {
  const results = searchSops('xyz123 nonexistent')
  if (results.length !== 0) throw new Error('should be empty')
})
test('sop: getSop returns the SOP', () => {
  const sop = getSop('restart-service')
  if (!sop) throw new Error('should find sop')
  if (sop.title !== 'Restart a Service') throw new Error('title')
  if (sop.steps.length !== 4) throw new Error(`expected 4 steps, got ${sop.steps.length}`)
})
test('sop: getSop returns null for unknown id', () => {
  if (getSop('nonexistent') !== null) throw new Error('should be null')
})
test('sop: searchIamPolicies finds password policy', () => {
  const results = searchIamPolicies('password')
  if (results.length === 0) throw new Error('should find password policy')
})
test('sop: buildStepCommand substitutes variables', () => {
  const step = { step: 1, action: 'Restart', command: 'systemctl restart {service}', verify: 'running' }
  const cmd = buildStepCommand(step, { service: 'nginx' })
  if (cmd !== 'systemctl restart nginx') throw new Error(`expected nginx, got ${cmd}`)
})
test('sop: BUILTIN_SOPS has 8 SOPs', () => {
  if (BUILTIN_SOPS.length !== 8) throw new Error(`expected 8, got ${BUILTIN_SOPS.length}`)
})
test('sop: IAM_POLICIES has 4 policies', () => {
  if (IAM_POLICIES.length !== 4) throw new Error(`expected 4, got ${IAM_POLICIES.length}`)
})
test('sop: register registers 4 tools, 1 trigger, 1 panel', () => {
  const tools: any[] = [], triggers: any[] = [], panels: any[] = []
  sopRegister({ registerTool: (t: any) => tools.push(t), registerTrigger: (t: any) => triggers.push(t), registerPanel: (p: any) => panels.push(p), exec: async () => '', log: () => {} })
  if (tools.length !== 4) throw new Error(`expected 4 tools, got ${tools.length}`)
  if (triggers.length !== 1) throw new Error(`expected 1 trigger, got ${triggers.length}`)
  if (panels.length !== 1) throw new Error(`expected 1 panel, got ${panels.length}`)
})

// ========== IAM CONNECTOR ==========
test('iam: buildUserInfoCommand for linux', () => {
  const cmd = buildUserInfoCommand('john', 'linux')
  if (!cmd.includes('id') && !cmd.includes('groups')) throw new Error('should include id/groups')
})
test('iam: buildUserInfoCommand for windows', () => {
  const cmd = buildUserInfoCommand('john', 'windows')
  if (!cmd.includes('Get-LocalUser')) throw new Error('should include Get-LocalUser')
})
test('iam: buildDisableUserCommand for linux', () => {
  const cmd = buildDisableUserCommand('john', 'linux')
  if (!cmd.includes('usermod')) throw new Error('should include usermod')
})
test('iam: parseUserInfo parses linux output', () => {
  const output = 'uid=1000(john) gid=1000(john) groups=1000(john),27(sudo)\njohn L 07/22/2026 0 99999 7 -1'
  const info = parseUserInfo(output, 'linux')
  if (info.username !== 'john') throw new Error('username')
  if (!info.groups.includes('sudo')) throw new Error('should have sudo group')
  if (!info.locked) throw new Error('should be locked')
})
test('iam: isPrivileged detects sudo', () => {
  if (!isPrivileged({ groups: ['john', 'sudo'] })) throw new Error('should be privileged')
})
test('iam: isPrivileged detects Administrators', () => {
  if (!isPrivileged({ groups: ['Users', 'Administrators'] })) throw new Error('should be privileged')
})
test('iam: isPrivileged returns false for regular user', () => {
  if (isPrivileged({ groups: ['john', 'users'] })) throw new Error('should not be privileged')
})
test('iam: register registers 4 tools, 1 trigger, 1 panel', () => {
  const tools: any[] = [], triggers: any[] = [], panels: any[] = []
  iamRegister({ registerTool: (t: any) => tools.push(t), registerTrigger: (t: any) => triggers.push(t), registerPanel: (p: any) => panels.push(p), exec: async () => '', readLedger: () => ({}), log: () => {} })
  if (tools.length !== 4) throw new Error(`expected 4 tools, got ${tools.length}`)
  if (triggers.length !== 1) throw new Error(`expected 1 trigger, got ${triggers.length}`)
  if (panels.length !== 1) throw new Error(`expected 1 panel, got ${panels.length}`)
})

// ========== FRAUDOPS ==========
test('fraudops: buildPipelineHealthCommand includes flink jobs endpoint', () => {
  const cmd = buildPipelineHealthCommand()
  if (!cmd.includes('8081') || !cmd.includes('jobs')) throw new Error('should include flink jobs endpoint')
})
test('fraudops: parsePipelineHealth parses valid JSON', () => {
  const output = JSON.stringify({ jobs: [{ jid: '1', name: 'fraud-pipeline', state: 'RUNNING' }] })
  const health = parsePipelineHealth(output)
  if (health.status !== 'healthy') throw new Error('should be healthy')
  if (health.running !== 1) throw new Error('should have 1 running')
})
test('fraudops: parsePipelineHealth handles invalid JSON', () => {
  const health = parsePipelineHealth('not json')
  if (health.status !== 'unknown') throw new Error('should be unknown')
})
test('fraudops: buildStrCase creates case with 7-day deadline', () => {
  const c = buildStrCase('txn-001', 'BLOCK', ['high_velocity'], 'analyst1')
  if (!c.id.startsWith('str-txn-001')) throw new Error('id format')
  if (c.status !== 'pending') throw new Error('status')
  if (c.deadline <= Date.now()) throw new Error('deadline should be in future')
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
  if (c.deadline - Date.now() < sevenDaysMs - 1000) throw new Error('should be ~7 days')
})
test('fraudops: buildDecisionSummary computes rates', () => {
  const decisions = [
    { decision: 'BLOCK' }, { decision: 'BLOCK' }, { decision: 'REVIEW' },
    { decision: 'APPROVE' }, { decision: 'APPROVE' }, { decision: 'APPROVE' },
  ]
  const s = buildDecisionSummary(decisions)
  if (s.total !== 6) throw new Error('total')
  if (s.blockRate !== 33) throw new Error(`expected 33%, got ${s.blockRate}%`)
  if (s.reviewRate !== 17) throw new Error(`expected 17%, got ${s.reviewRate}%`)
  if (s.approveRate !== 50) throw new Error(`expected 50%, got ${s.approveRate}%`)
})
test('fraudops: buildDecisionSummary handles empty', () => {
  const s = buildDecisionSummary([])
  if (s.total !== 0) throw new Error('should be 0')
  if (s.blockRate !== 0) throw new Error('should be 0')
})
test('fraudops: register registers 4 tools, 2 triggers, 1 panel', () => {
  const tools: any[] = [], triggers: any[] = [], panels: any[] = []
  fraudopsRegister({ registerTool: (t: any) => tools.push(t), registerTrigger: (t: any) => triggers.push(t), registerPanel: (p: any) => panels.push(p), exec: async () => '', readLedger: () => ({}), log: () => {} })
  if (tools.length !== 4) throw new Error(`expected 4 tools, got ${tools.length}`)
  if (triggers.length !== 2) throw new Error(`expected 2 triggers, got ${triggers.length}`)
  if (panels.length !== 1) throw new Error(`expected 1 panel, got ${panels.length}`)
})

async function main() {
  let pass = 0, fail = 0
  for (const c of cases) {
    try { await c.run(); pass++; console.log(`PASS ${c.name}`) }
    catch (e: any) { fail++; console.log(`FAIL ${c.name}: ${e?.message ?? e}`) }
  }
  console.log(`\n${pass}/${cases.length} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
void main()
