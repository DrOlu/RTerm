import { AgtPolicyEngine, parsePolicyYaml, parsePolicyJson, type PolicyDocument } from './agtPolicyEngine'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

// ---- AgtPolicyEngine: load + evaluate ----
test('load: loads the policy document', async () => {
  const doc: PolicyDocument = {
    name: 'test-policy', version: '1.0', defaultDecision: 'deny',
    rules: [{ name: 'allow-read', actionPattern: 'read', decision: 'allow' }],
  }
  const engine = new AgtPolicyEngine({ loadPolicy: async () => doc })
  await engine.load()
  if (engine.getPolicy()?.name !== 'test-policy') throw new Error('should load policy')
})

test('evaluate: allow when rule matches', async () => {
  const doc: PolicyDocument = {
    name: 'test-policy', version: '1.0', defaultDecision: 'deny',
    rules: [{ name: 'allow-read', actionPattern: 'read', decision: 'allow' }],
  }
  const engine = new AgtPolicyEngine({ loadPolicy: async () => doc })
  await engine.load()
  const result = engine.evaluate('read /etc/passwd')
  if (result.decision !== 'allow') throw new Error(`expected allow, got ${result.decision}`)
  if (result.rule !== 'allow-read') throw new Error(`expected allow-read, got ${result.rule}`)
})

test('evaluate: deny when rule matches', async () => {
  const doc: PolicyDocument = {
    name: 'test-policy', version: '1.0', defaultDecision: 'allow',
    rules: [{ name: 'deny-delete', actionPattern: 'delete', decision: 'deny' }],
  }
  const engine = new AgtPolicyEngine({ loadPolicy: async () => doc })
  await engine.load()
  const result = engine.evaluate('delete /tmp/data')
  if (result.decision !== 'deny') throw new Error(`expected deny, got ${result.decision}`)
})

test('evaluate: escalate when rule matches', async () => {
  const doc: PolicyDocument = {
    name: 'test-policy', version: '1.0', defaultDecision: 'allow',
    rules: [{ name: 'escalate-prod', actionPattern: 'restart', targetPattern: 'prod-*', decision: 'escalate' }],
  }
  const engine = new AgtPolicyEngine({ loadPolicy: async () => doc })
  await engine.load()
  const result = engine.evaluate('restart nginx', 'prod-web-01')
  if (result.decision !== 'escalate') throw new Error(`expected escalate, got ${result.decision}`)
  if (result.rule !== 'escalate-prod') throw new Error(`expected escalate-prod, got ${result.rule}`)
})

test('evaluate: default when no rule matches', async () => {
  const doc: PolicyDocument = {
    name: 'test-policy', version: '1.0', defaultDecision: 'deny',
    rules: [{ name: 'allow-read', actionPattern: 'read', decision: 'allow' }],
  }
  const engine = new AgtPolicyEngine({ loadPolicy: async () => doc })
  await engine.load()
  const result = engine.evaluate('write /tmp/data')
  if (result.decision !== 'deny') throw new Error(`expected deny (default), got ${result.decision}`)
  if (result.rule !== 'default') throw new Error(`expected default, got ${result.rule}`)
})

test('evaluate: target pattern matching with wildcard', async () => {
  const doc: PolicyDocument = {
    name: 'test-policy', version: '1.0', defaultDecision: 'allow',
    rules: [{ name: 'deny-prod', actionPattern: 'patch', targetPattern: 'prod-*', decision: 'deny' }],
  }
  const engine = new AgtPolicyEngine({ loadPolicy: async () => doc })
  await engine.load()
  const prodResult = engine.evaluate('patch', 'prod-web-01')
  if (prodResult.decision !== 'deny') throw new Error('should deny prod')
  const devResult = engine.evaluate('patch', 'dev-web-01')
  if (devResult.decision !== 'allow') throw new Error('should allow dev (default)')
})

test('evaluate: first matching rule wins', async () => {
  const doc: PolicyDocument = {
    name: 'test-policy', version: '1.0', defaultDecision: 'deny',
    rules: [
      { name: 'allow-read', actionPattern: 'read', decision: 'allow' },
      { name: 'deny-read', actionPattern: 'read', decision: 'deny' },
    ],
  }
  const engine = new AgtPolicyEngine({ loadPolicy: async () => doc })
  await engine.load()
  const result = engine.evaluate('read /etc/passwd')
  if (result.decision !== 'allow') throw new Error('first rule should win')
})

test('evaluate: throws when policy not loaded', () => {
  const engine = new AgtPolicyEngine({ loadPolicy: async () => ({ name: '', version: '', defaultDecision: 'deny', rules: [] }) })
  try {
    engine.evaluate('read /etc/passwd')
    throw new Error('should have thrown')
  } catch (e: any) {
    if (!e.message.includes('not loaded')) throw new Error('should throw not loaded')
  }
})

test('evaluate: case-insensitive matching', async () => {
  const doc: PolicyDocument = {
    name: 'test-policy', version: '1.0', defaultDecision: 'deny',
    rules: [{ name: 'allow-read', actionPattern: 'READ', decision: 'allow' }],
  }
  const engine = new AgtPolicyEngine({ loadPolicy: async () => doc })
  await engine.load()
  const result = engine.evaluate('read /etc/passwd')
  if (result.decision !== 'allow') throw new Error('should match case-insensitively')
})

// ---- parsePolicyYaml ----
test('parsePolicyYaml: parses a simple policy', () => {
  const yaml = `name: production-policy
version: '1.0'
defaultDecision: deny
rules:
  - name: allow-read
    actionPattern: read
    decision: allow
  - name: deny-delete
    actionPattern: delete
    decision: deny`
  const doc = parsePolicyYaml(yaml)
  if (doc.name !== 'production-policy') throw new Error('name')
  if (doc.version !== "'1.0'") throw new Error('version')
  if (doc.defaultDecision !== 'deny') throw new Error('defaultDecision')
  if (doc.rules.length !== 2) throw new Error(`expected 2 rules, got ${doc.rules.length}`)
  if (doc.rules[0].name !== 'allow-read') throw new Error('first rule name')
  if (doc.rules[1].name !== 'deny-delete') throw new Error('second rule name')
})

test('parsePolicyYaml: handles comments and empty lines', () => {
  const yaml = `# This is a comment
name: test-policy

version: '1.0'
defaultDecision: allow
# Another comment
rules:
  - name: allow-all
    actionPattern: '*'
    decision: allow`
  const doc = parsePolicyYaml(yaml)
  if (doc.name !== 'test-policy') throw new Error('name')
  if (doc.rules.length !== 1) throw new Error('rules')
})

test('parsePolicyYaml: handles targetPattern', () => {
  const yaml = `name: test-policy
version: '1.0'
defaultDecision: deny
rules:
  - name: escalate-prod
    actionPattern: restart
    targetPattern: prod-*
    decision: escalate`
  const doc = parsePolicyYaml(yaml)
  if (doc.rules[0].targetPattern !== 'prod-*') throw new Error('targetPattern')
})

// ---- parsePolicyJson ----
test('parsePolicyJson: parses a JSON policy', () => {
  const json = JSON.stringify({
    name: 'test-policy', version: '1.0', defaultDecision: 'deny',
    rules: [{ name: 'allow-read', actionPattern: 'read', decision: 'allow' }],
  })
  const doc = parsePolicyJson(json)
  if (doc.name !== 'test-policy') throw new Error('name')
  if (doc.rules.length !== 1) throw new Error('rules')
})

// ---- identity ----
test('getAgentIdentity returns the configured identity', () => {
  const engine = new AgtPolicyEngine({ loadPolicy: async () => ({ name: '', version: '', defaultDecision: 'deny', rules: [] }), agentIdentity: 'rterm-agent-v2.7.7' })
  if (engine.getAgentIdentity() !== 'rterm-agent-v2.7.7') throw new Error('agent identity')
})

test('getSponsoringPrincipal returns the configured principal', () => {
  const engine = new AgtPolicyEngine({ loadPolicy: async () => ({ name: '', version: '', defaultDecision: 'deny', rules: [] }), sponsoringPrincipal: 'olu@company.com' })
  if (engine.getSponsoringPrincipal() !== 'olu@company.com') throw new Error('sponsoring principal')
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
