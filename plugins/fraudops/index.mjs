/**
 * fraudops plugin — FraudOps for RTerm.
 *
 * Operational layer for the fraud detection pipeline. Monitors pipeline health
 * (Flink, NATS, Kafka), manages STR workflow, tracks fraud incidents, and
 * provides the unified fraud operations dashboard. Bridges Kafka/NATS metrics
 * into RTerm's SRE pillar.
 */

// --- Pure: build pipeline health check command ---
export function buildPipelineHealthCommand() {
  return 'curl -s http://localhost:8081/jobs 2>/dev/null | head -20 || echo "flink not reachable"'
}

// --- Pure: build NATS JetStream status command ---
export function buildNatsStatusCommand() {
  return 'curl -s http://localhost:8222/streaming/channelsz 2>/dev/null | head -30 || echo "nats not reachable"'
}

// --- Pure: build Kafka consumer lag command ---
export function buildKafkaLagCommand() {
  return 'kafka-consumer-groups --bootstrap-server localhost:9092 --describe --group fraud-pipeline 2>/dev/null | head -20 || echo "kafka not reachable"'
}

// --- Pure: parse pipeline health output ---
export function parsePipelineHealth(output) {
  const health = { status: 'unknown', jobs: [], running: 0, failed: 0 }
  try {
    const parsed = JSON.parse(output)
    if (parsed.jobs && Array.isArray(parsed.jobs)) {
      health.jobs = parsed.jobs.map((j) => ({ id: j.jid, name: j.name, status: j.state }))
      health.running = parsed.jobs.filter((j) => j.state === 'RUNNING').length
      health.failed = parsed.jobs.filter((j) => j.state === 'FAILED').length
      health.status = health.failed > 0 ? 'degraded' : health.running > 0 ? 'healthy' : 'unknown'
    }
  } catch { /* not JSON */ }
  return health
}

// --- Pure: build an STR case record ---
export function buildStrCase(txnId, decision, indicators, assignedTo) {
  return {
    id: `str-${txnId}-${Date.now().toString(36)}`,
    txnId,
    decision, // BLOCK | REVIEW
    indicators: indicators ?? [],
    assignedTo: assignedTo ?? 'unassigned',
    status: 'pending', // pending | assigned | reviewed | filed | expired
    deadline: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days (CBN requirement)
    createdAt: Date.now(),
  }
}

// --- Pure: build a decision summary ---
export function buildDecisionSummary(decisions) {
  const total = decisions.length
  const blocks = decisions.filter((d) => d.decision === 'BLOCK').length
  const reviews = decisions.filter((d) => d.decision === 'REVIEW').length
  const approves = decisions.filter((d) => d.decision === 'APPROVE').length
  return {
    total,
    blocks,
    reviews,
    approves,
    blockRate: total > 0 ? Math.round((blocks / total) * 100) : 0,
    reviewRate: total > 0 ? Math.round((reviews / total) * 100) : 0,
    approveRate: total > 0 ? Math.round((approves / total) * 100) : 0,
  }
}

// --- Plugin entry ---
export function register(ctx) {
  const { registerTool, registerTrigger, registerPanel, exec, readLedger, log } = ctx
  const strCases = []

  // Tool: fraudops_pipeline_status — check the health of the fraud pipeline
  registerTool({
    name: 'fraudops_pipeline_status',
    description: 'Check the health of the fraud detection pipeline (Flink jobs, NATS JetStream, Kafka consumer lag). Returns status for each component.',
    params: {},
    handler: async () => {
      const flinkOut = await exec(buildPipelineHealthCommand(), {})
      const natsOut = await exec(buildNatsStatusCommand(), {})
      const kafkaOut = await exec(buildKafkaLagCommand(), {})
      const flink = parsePipelineHealth(flinkOut)
      log(`[fraudops] pipeline status: flink=${flink.status} nats=${natsOut.slice(0, 50)} kafka=${kafkaOut.slice(0, 50)}`)
      return { flink, nats: natsOut.slice(0, 500), kafka: kafkaOut.slice(0, 500) }
    },
  })

  // Tool: fraudops_str_assign — assign an STR case to an analyst
  registerTool({
    name: 'fraudops_str_assign',
    description: 'Assign an STR (Suspicious Transaction Report) case to an analyst. Creates the case with a 7-day CBN deadline.',
    params: {
      txnId: { type: 'string', description: 'Transaction ID' },
      decision: { type: 'string', description: 'BLOCK or REVIEW' },
      indicators: { type: 'array', description: 'Fraud indicators (e.g., ["high_velocity", "new_device"])' },
      assignedTo: { type: 'string', description: 'Analyst username' },
    },
    handler: async (params) => {
      const { txnId, decision, indicators, assignedTo } = params ?? {}
      if (!txnId || !decision) return { error: 'txnId and decision are required' }
      const strCase = buildStrCase(txnId, decision, indicators, assignedTo)
      strCase.status = 'assigned'
      strCases.push(strCase)
      log(`[fraudops] STR case ${strCase.id} assigned to ${assignedTo}`)
      return strCase
    },
  })

  // Tool: fraudops_str_status — get STR case status
  registerTool({
    name: 'fraudops_str_status',
    description: 'Get the status of STR cases. Filter by status, analyst, or overdue.',
    params: {
      status: { type: 'string', description: 'Filter by status: pending, assigned, reviewed, filed, expired' },
      assignedTo: { type: 'string', description: 'Filter by analyst' },
      overdue: { type: 'boolean', description: 'Only show overdue cases (past 7-day deadline)' },
    },
    handler: async (params) => {
      let filtered = [...strCases]
      if (params?.status) filtered = filtered.filter((c) => c.status === params.status)
      if (params?.assignedTo) filtered = filtered.filter((c) => c.assignedTo === params.assignedTo)
      if (params?.overdue) filtered = filtered.filter((c) => Date.now() > c.deadline)
      return { total: filtered.length, cases: filtered }
    },
  })

  // Tool: fraudops_decision_summary — summarize fraud decisions
  registerTool({
    name: 'fraudops_decision_summary',
    description: 'Summarize fraud decisions (BLOCK/REVIEW/APPROVE counts and rates) from the decision stream.',
    params: {
      decisions: { type: 'array', description: 'Array of decision objects with { decision: "BLOCK"|"REVIEW"|"APPROVE" }' },
    },
    handler: async (params) => {
      const decisions = params?.decisions ?? []
      const summary = buildDecisionSummary(decisions)
      log(`[fraudops] decision summary: ${summary.total} total, ${summary.blockRate}% block, ${summary.reviewRate}% review`)
      return summary
    },
  })

  // Trigger: fraudops_str_overdue — fires when an STR case is overdue
  registerTrigger({
    name: 'fraudops_str_overdue',
    description: 'Fires when an STR case exceeds the 7-day CBN deadline. Use for escalation to senior analyst.',
    match: (event) => {
      if (event?.source !== 'fraudops') return false
      return event.labels?.status === 'expired' || event.labels?.overdue === true
    },
    action: 'propose-change',
  })

  // Trigger: fraudops_pipeline_down — fires when a pipeline component is down
  registerTrigger({
    name: 'fraudops_pipeline_down',
    description: 'Fires when a fraud pipeline component (Flink, NATS, Kafka) is detected as down. Use for immediate incident response.',
    match: (event) => {
      if (event?.source !== 'fraudops') return false
      return event.labels?.status === 'down' || event.labels?.failed === true
    },
    action: 'run-playbook',
  })

  // Panel: fraudops-dashboard — unified fraud operations dashboard
  registerPanel({
    name: 'fraudops-dashboard',
    title: 'Fraud Operations Dashboard',
    render: (data) => {
      const cases = Array.isArray(data?.cases) ? data.cases : strCases
      const summary = data?.summary ?? { total: 0, blocks: 0, reviews: 0, approves: 0, blockRate: 0, reviewRate: 0, approveRate: 0 }
      const rows = cases.map((c) =>
        `<tr><td>${c.id}</td><td>${c.txnId}</td><td>${c.decision}</td><td>${c.assignedTo}</td><td>${c.status}</td><td>${new Date(c.deadline).toLocaleDateString()}</td></tr>`
      ).join('')
      return `<div class="fraudops-dashboard"><h3>Fraud Operations Dashboard</h3><p>Decisions: ${summary.total} | Block: ${summary.blockRate}% | Review: ${summary.reviewRate}% | Approve: ${summary.approveRate}%</p><p>STR Cases: ${cases.length} | Overdue: ${cases.filter((c) => Date.now() > c.deadline).length}</p><table><thead><tr><th>ID</th><th>Txn ID</th><th>Decision</th><th>Assigned</th><th>Status</th><th>Deadline</th></tr></thead><tbody>${rows}</tbody></table></div>`
    },
  })

  log('[fraudops] registered: 4 tools, 2 triggers, 1 panel')
}

export default { register, buildPipelineHealthCommand, buildNatsStatusCommand, buildKafkaLagCommand, parsePipelineHealth, buildStrCase, buildDecisionSummary }
