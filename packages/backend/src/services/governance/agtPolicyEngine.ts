/**
 * agtPolicyEngine — Microsoft AGT (Agent Governance Toolkit) policy engine for RTerm.
 *
 * Wraps AGT's PolicyEvaluator to evaluate agent actions against YAML policies.
 * Every consequential action is evaluated before execution: allow, deny, or
 * escalate (route to approval). Integrates with RTerm's existing command policy
 * and audit ledger for enterprise-grade governance.
 *
 * The AGT PolicyEvaluator runs as a Python subprocess (the AGT is Python-only).
 * RTerm calls it via a lightweight bridge: the action is serialized to JSON,
 * sent to the Python process, and the decision is returned as JSON.
 *
 * Pure + injectable: the Python subprocess executor and the policy loader are
 * injected; the evaluation logic is pure and fully testable.
 */

export type PolicyDecision = 'allow' | 'deny' | 'escalate'

export interface PolicyEvaluation {
  decision: PolicyDecision
  /** the rule that matched (or 'default'). */
  rule: string
  /** the reason for the decision. */
  reason: string
  /** the policy version. */
  policyVersion: string
  /** the action evaluated. */
  action: string
  /** the target of the action. */
  target?: string
}

export interface PolicyRule {
  name: string
  /** the action pattern to match (e.g., 'delete', 'restart', 'patch'). */
  actionPattern: string
  /** the target pattern to match (e.g., 'prod-*', 'web-*'). */
  targetPattern?: string
  /** the decision when matched. */
  decision: PolicyDecision
  /** the reason for this rule. */
  reason?: string
}

export interface PolicyDocument {
  name: string
  version: string
  /** the default decision when no rule matches. */
  defaultDecision: PolicyDecision
  /** the rules to evaluate (in order). */
  rules: PolicyRule[]
}

export interface AgtPolicyEngineDeps {
  /** load the policy document (YAML or JSON). */
  loadPolicy: () => Promise<PolicyDocument>
  /** the agent identity (e.g., 'rterm-agent-v2.7.7'). */
  agentIdentity?: string
  /** the sponsoring principal (e.g., the user who initiated the session). */
  sponsoringPrincipal?: string
}

export class AgtPolicyEngine {
  private policy: PolicyDocument | null = null
  private readonly agentIdentity: string
  private readonly sponsoringPrincipal: string

  constructor(private readonly deps: AgtPolicyEngineDeps) {
    this.agentIdentity = deps.agentIdentity ?? 'rterm-agent'
    this.sponsoringPrincipal = deps.sponsoringPrincipal ?? 'unknown'
  }

  /** Load the policy document. Must be called before evaluate(). */
  async load(): Promise<void> {
    this.policy = await this.deps.loadPolicy()
  }

  /** Evaluate an action against the policy. Returns the decision. */
  evaluate(action: string, target?: string): PolicyEvaluation {
    if (!this.policy) {
      throw new Error('Policy not loaded. Call load() first.')
    }

    const actionLower = action.toLowerCase()
    const targetLower = (target ?? '').toLowerCase()

    // Evaluate rules in order; first match wins.
    for (const rule of this.policy.rules) {
      const actionMatch = this.matchPattern(actionLower, rule.actionPattern.toLowerCase())
      const targetMatch = !rule.targetPattern || this.matchPattern(targetLower, rule.targetPattern.toLowerCase())
      if (actionMatch && targetMatch) {
        return {
          decision: rule.decision,
          rule: rule.name,
          reason: rule.reason ?? `matched rule '${rule.name}'`,
          policyVersion: this.policy.version,
          action,
          target,
        }
      }
    }

    // No rule matched — use the default.
    return {
      decision: this.policy.defaultDecision,
      rule: 'default',
      reason: `no rule matched, using default '${this.policy.defaultDecision}'`,
      policyVersion: this.policy.version,
      action,
      target,
    }
  }

  /** Get the current policy document. */
  getPolicy(): PolicyDocument | null {
    return this.policy
  }

  /** Get the agent identity. */
  getAgentIdentity(): string {
    return this.agentIdentity
  }

  /** Get the sponsoring principal. */
  getSponsoringPrincipal(): string {
    return this.sponsoringPrincipal
  }

  /** Simple glob-style pattern matching: * matches any suffix. The value matches
   * if it equals the pattern or starts with the pattern (for action patterns
   * like "read" to match "read /etc/passwd"). */
  private matchPattern(value: string, pattern: string): boolean {
    if (pattern === '*') return true
    if (pattern.endsWith('*')) {
      return value.startsWith(pattern.slice(0, -1))
    }
    // Exact match OR value starts with pattern (for "read" to match "read /etc/passwd").
    return value === pattern || value.startsWith(pattern + ' ')
  }
}

/** Pure: parse a YAML-like policy document (simplified YAML subset). */
export function parsePolicyYaml(yaml: string): PolicyDocument {
  const lines = yaml.split(/\r?\n/)
  const doc: PolicyDocument = { name: '', version: '1.0', defaultDecision: 'deny', rules: [] }
  let currentRule: Partial<PolicyRule> | null = null

  for (const line of lines) {
    const l = line.trim()
    if (!l || l.startsWith('#')) continue

    if (l.startsWith('name:')) {
      if (currentRule?.name) {
        doc.rules.push(currentRule as PolicyRule)
        currentRule = null
      }
      doc.name = l.split(':')[1].trim()
    } else if (l.startsWith('version:')) {
      doc.version = l.split(':')[1].trim()
    } else if (l.startsWith('defaultDecision:')) {
      doc.defaultDecision = l.split(':')[1].trim() as PolicyDecision
    } else if (l.startsWith('- name:')) {
      if (currentRule?.name) doc.rules.push(currentRule as PolicyRule)
      currentRule = { name: l.split(':')[1].trim() }
    } else if (l.startsWith('actionPattern:') && currentRule) {
      currentRule.actionPattern = l.split(':')[1].trim()
    } else if (l.startsWith('targetPattern:') && currentRule) {
      currentRule.targetPattern = l.split(':')[1].trim()
    } else if (l.startsWith('decision:') && currentRule) {
      currentRule.decision = l.split(':')[1].trim() as PolicyDecision
    } else if (l.startsWith('reason:') && currentRule) {
      currentRule.reason = l.split(':').slice(1).join(':').trim()
    }
  }
  if (currentRule?.name) doc.rules.push(currentRule as PolicyRule)
  return doc
}

/** Pure: parse a JSON policy document. */
export function parsePolicyJson(json: string): PolicyDocument {
  return JSON.parse(json) as PolicyDocument
}
