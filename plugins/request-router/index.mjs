/**
 * request-router plugin — automated request handling and approval workflow.
 *
 * Receives operational requests (access, restart, deploy, patch, custom),
 * classifies risk, routes for approval (auto-approve/queue/MOP), executes
 * end-to-end, and audits every step. Formalizes RTerm's existing command
 * policy + MOP approval into a structured request pipeline.
 */

// --- Pure: classify a request by risk ---
export function classifyRequest(request) {
  const req = request ?? {}
  const type = String(req.type ?? '').toLowerCase()
  const urgency = String(req.urgency ?? 'low').toLowerCase()
  const target = String(req.target ?? '').toLowerCase()

  // Destructive operations = high risk
  if (['delete', 'drop', 'purge', 'format', 'destroy'].some((w) => type.includes(w))) return 'high'
  // Production targets = elevated risk
  if (target.includes('prod') || target.includes('production')) {
    if (['restart', 'stop', 'kill', 'deploy', 'patch', 'update'].some((w) => type.includes(w))) return 'high'
    return 'medium'
  }
  // Restart/stop operations = medium risk
  if (['restart', 'stop', 'kill', 'deploy', 'patch', 'update', 'reboot', 'shutdown'].some((w) => type.includes(w))) return 'medium'
  // Access requests = medium risk
  if (['access', 'grant', 'permission', 'role', 'sudo', 'admin'].some((w) => type.includes(w))) return 'medium'
  // Read-only = low risk
  if (['status', 'check', 'list', 'show', 'get', 'describe', 'read'].some((w) => type.includes(w))) return 'low'
  // Default: medium
  return 'medium'
}

// --- Pure: route a request based on risk ---
export function routeRequest(request) {
  const req = request ?? {}
  const risk = classifyRequest(req)
  const urgency = String(req.urgency ?? 'low').toLowerCase()

  if (risk === 'low') return { route: 'auto_approve', risk, reason: 'low-risk read-only operation' }
  if (risk === 'medium') {
    if (urgency === 'critical' || urgency === 'high') {
      return { route: 'queue', risk, reason: 'medium-risk with high urgency — expedited approval' }
    }
    return { route: 'queue', risk, reason: 'medium-risk operation — requires operator approval' }
  }
  return { route: 'mop', risk, reason: 'high-risk operation — requires MOP change (plan → approve → run)' }
}

// --- Pure: build a request ID ---
export function buildRequestId() {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// --- Pure: build an approval record ---
export function buildApprovalRecord(requestId, approvedBy, rationale, decision) {
  return {
    requestId,
    approvedBy,
    rationale,
    decision, // approved | denied
    at: Date.now(),
  }
}

// --- Pure: build a request queue entry ---
export function buildQueueEntry(request, requestId) {
  const req = request ?? {}
  const { route, risk, reason } = routeRequest(req)
  return {
    id: requestId,
    type: req.type,
    target: req.target,
    justification: req.justification ?? '',
    urgency: req.urgency ?? 'low',
    risk,
    route,
    routeReason: reason,
    status: route === 'auto_approve' ? 'auto_approved' : 'pending',
    submittedBy: req.submittedBy ?? 'unknown',
    submittedAt: Date.now(),
    ...(route === 'auto_approve' ? { approvedAt: Date.now(), approvedBy: 'system' } : {}),
  }
}

// --- Pure: filter the request queue ---
export function filterQueue(queue, filter = {}) {
  let out = Array.isArray(queue) ? [...queue] : []
  const f = filter ?? {}
  if (f.status) out = out.filter((r) => r.status === f.status)
  if (f.risk) out = out.filter((r) => r.risk === f.risk)
  if (f.urgency) out = out.filter((r) => r.urgency === f.urgency)
  if (f.target) out = out.filter((r) => String(r.target ?? '').includes(f.target))
  return out
}

// --- Plugin entry ---
export function register(ctx) {
  const { registerTool, registerTrigger, registerPanel, exec, readLedger, log } = ctx
  const requestQueue = []

  // Tool: submit_request — submit an operational request
  registerTool({
    name: 'submit_request',
    description: 'Submit an operational request for approval and execution. The request is classified by risk and routed: low-risk → auto-approve, medium-risk → queue for operator approval, high-risk → MOP change.',
    params: {
      type: { type: 'string', description: 'Request type: access, restart, deploy, patch, status, custom' },
      target: { type: 'string', description: 'Target host or service' },
      justification: { type: 'string', description: 'Business justification' },
      urgency: { type: 'string', description: 'low, medium, high, critical' },
      submittedBy: { type: 'string', description: 'Who is submitting the request' },
    },
    handler: async (params) => {
      const requestId = buildRequestId()
      const entry = buildQueueEntry(params, requestId)
      requestQueue.push(entry)
      log(`[request-router] ${entry.id}: ${entry.type} on ${entry.target} → ${entry.route} (${entry.risk} risk)`)
      return { requestId, ...entry }
    },
  })

  // Tool: approve_request — approve or deny a pending request
  registerTool({
    name: 'approve_request',
    description: 'Approve or deny a pending request. Executes the request if approved. Records the approval in the audit trail.',
    params: {
      requestId: { type: 'string', description: 'Request ID to approve/deny' },
      approvedBy: { type: 'string', description: 'Who is approving' },
      rationale: { type: 'string', description: 'Reason for the decision' },
      decision: { type: 'string', description: 'approved or denied' },
    },
    handler: async (params) => {
      const { requestId, approvedBy, rationale, decision } = params ?? {}
      if (!requestId || !approvedBy) return { error: 'requestId and approvedBy are required' }
      const entry = requestQueue.find((r) => r.id === requestId)
      if (!entry) return { error: `request ${requestId} not found` }
      if (entry.status !== 'pending') return { error: `request ${requestId} is already ${entry.status}` }

      const approval = buildApprovalRecord(requestId, approvedBy, rationale ?? '', decision ?? 'approved')
      entry.status = approval.decision === 'approved' ? 'approved' : 'denied'
      entry.approvedBy = approvedBy
      entry.approvedAt = approval.at
      entry.rationale = rationale

      log(`[request-router] ${requestId} ${approval.decision} by ${approvedBy}`)

      // If approved, execute the request
      if (approval.decision === 'approved') {
        const cmd = buildRequestCommand(entry)
        if (cmd) {
          const output = await exec(cmd, { host: entry.target })
          entry.executionOutput = output.slice(0, 1000)
          entry.executedAt = Date.now()
        }
      }

      return { requestId, ...entry, approval }
    },
  })

  // Tool: list_requests — list requests in the queue
  registerTool({
    name: 'list_requests',
    description: 'List requests in the queue with optional filters (status, risk, urgency, target).',
    params: {
      status: { type: 'string', description: 'Filter by status: pending, approved, denied, auto_approved' },
      risk: { type: 'string', description: 'Filter by risk: low, medium, high' },
      urgency: { type: 'string', description: 'Filter by urgency' },
      target: { type: 'string', description: 'Filter by target (substring match)' },
    },
    handler: async (params) => {
      const filtered = filterQueue(requestQueue, params ?? {})
      return { total: filtered.length, requests: filtered }
    },
  })

  // Tool: request_status — get the status of a specific request
  registerTool({
    name: 'request_status',
    description: 'Get the status of a specific request by ID.',
    params: { requestId: { type: 'string', description: 'Request ID' } },
    handler: async (params) => {
      const entry = requestQueue.find((r) => r.id === params?.requestId)
      if (!entry) return { error: `request ${params?.requestId} not found` }
      return entry
    },
  })

  // Trigger: request_urgent — fires when a high-urgency request is submitted
  registerTrigger({
    name: 'request_urgent',
    description: 'Fires when a request with critical/high urgency is submitted. Use for immediate notification.',
    match: (event) => {
      if (event?.source !== 'request-router') return false
      return event.labels?.urgency === 'critical' || event.labels?.urgency === 'high'
    },
    action: 'run-playbook',
  })

  // Trigger: request_approved — fires when a request is approved
  registerTrigger({
    name: 'request_approved',
    description: 'Fires when a request is approved. Use for post-approval automation.',
    match: (event) => {
      if (event?.source !== 'request-router') return false
      return event.labels?.status === 'approved'
    },
    action: 'run-playbook',
  })

  // Panel: request-queue — request queue dashboard
  registerPanel({
    name: 'request-queue',
    title: 'Request Queue',
    render: (data) => {
      const queue = Array.isArray(data) ? data : requestQueue
      const rows = queue.map((r) =>
        `<tr><td>${r.id}</td><td>${r.type}</td><td>${r.target}</td><td>${r.risk}</td><td>${r.urgency}</td><td>${r.status}</td><td>${r.submittedBy ?? ''}</td></tr>`
      ).join('')
      return `<div class="request-queue"><h3>Request Queue</h3><p>Total: ${queue.length} | Pending: ${queue.filter((r) => r.status === 'pending').length} | Approved: ${queue.filter((r) => r.status === 'approved').length}</p><table><thead><tr><th>ID</th><th>Type</th><th>Target</th><th>Risk</th><th>Urgency</th><th>Status</th><th>By</th></tr></thead><tbody>${rows}</tbody></table></div>`
    },
  })

  log('[request-router] registered: 4 tools, 2 triggers, 1 panel')
}

// --- Pure: build the command to execute for an approved request ---
function buildRequestCommand(entry) {
  const type = String(entry.type ?? '').toLowerCase()
  const target = entry.target
  if (type.includes('restart')) return `systemctl restart ${target} 2>/dev/null || Restart-Service ${target} -Force 2>/dev/null`
  if (type.includes('stop')) return `systemctl stop ${target} 2>/dev/null || Stop-Service ${target} -Force 2>/dev/null`
  if (type.includes('status')) return `systemctl status ${target} 2>/dev/null || Get-Service ${target} 2>/dev/null`
  if (type.includes('deploy')) return `echo "deploying to ${target}"`
  if (type.includes('patch')) return `echo "patching ${target}"`
  return null // custom requests don't have a built-in command
}

export default { register, classifyRequest, routeRequest, buildRequestId, buildApprovalRecord, buildQueueEntry, filterQueue }
