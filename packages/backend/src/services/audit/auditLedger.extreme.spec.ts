import { AuditLedger, computeRecordHash } from './auditLedger'
import { EvidenceSealer, computeMerkleRoot, verifyMerkleRoot } from './evidenceSealer'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

// ---- AuditLedger: append + basic operations ----
test('append: creates a record with hash, prevHash, and seq', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  const r = ledger.append({ kind: 'agent_run_start', actor: 'olu', target: 'web-01', summary: 'Run started' })
  if (!r.id) throw new Error('should have id')
  if (!r.hash) throw new Error('should have hash')
  if (r.seq !== 1) throw new Error('first record should be seq 1')
  if (r.prevHash !== '0'.repeat(64)) throw new Error('first record should have genesis prevHash')
  if (r.at !== 1000) throw new Error('at should use injected clock')
})

test('append: second record chains to first', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  const r1 = ledger.append({ kind: 'agent_run_start', actor: 'olu', target: 'web-01', summary: 'Run started' })
  const r2 = ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls' })
  if (r2.seq !== 2) throw new Error('second record should be seq 2')
  if (r2.prevHash !== r1.hash) throw new Error('second record should chain to first')
  if (r2.hash === r1.hash) throw new Error('hashes should differ')
})

test('append: uses provided at timestamp when given', () => {
  const ledger = new AuditLedger({ now: () => 9999 })
  const r = ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls', at: 5000 })
  if (r.at !== 5000) throw new Error('should use provided at')
})

test('append: stores detail when provided', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  const r = ledger.append({
    kind: 'command_evaluated', actor: 'agent', target: 'web-01', summary: 'Evaluated ls',
    detail: { policy: 'standard', rule: 'read-only', decision: 'allow' },
  })
  if (!r.detail || r.detail.policy !== 'standard') throw new Error('should store detail')
})

test('append: omits detail when not provided', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  const r = ledger.append({ kind: 'agent_run_start', actor: 'olu', target: 'web-01', summary: 'Run started' })
  if ('detail' in r && r.detail !== undefined) throw new Error('should not have detail')
})

// ---- AuditLedger: query methods ----
test('list: returns all records in order', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  ledger.append({ kind: 'agent_run_start', actor: 'olu', target: 'web-01', summary: 'Run started' })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls' })
  ledger.append({ kind: 'agent_run_end', actor: 'olu', target: 'web-01', summary: 'Run completed' })
  const all = ledger.list()
  if (all.length !== 3) throw new Error('should have 3 records')
  if (all[0].seq !== 1 || all[1].seq !== 2 || all[2].seq !== 3) throw new Error('should be in order')
})

test('listByKind: filters by event kind', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls' })
  ledger.append({ kind: 'command_approved', actor: 'olu', target: 'web-01', summary: 'Approved' })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ps' })
  const execs = ledger.listByKind('command_executed')
  if (execs.length !== 2) throw new Error('should have 2 command_executed')
  const approvals = ledger.listByKind('command_approved')
  if (approvals.length !== 1) throw new Error('should have 1 command_approved')
})

test('listByTarget: filters by target', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls' })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-02', summary: 'Ran ps' })
  const web01 = ledger.listByTarget('web-01')
  if (web01.length !== 1) throw new Error('should have 1 web-01 record')
})

test('listByActor: filters by actor', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  ledger.append({ kind: 'command_approved', actor: 'olu', target: 'web-01', summary: 'Approved' })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls' })
  const olu = ledger.listByActor('olu')
  if (olu.length !== 1) throw new Error('should have 1 olu record')
})

test('listInRange: filters by time range', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls', at: 1000 })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ps', at: 2000 })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran df', at: 3000 })
  const range = ledger.listInRange(1500, 2500)
  if (range.length !== 1) throw new Error('should have 1 record in range')
  if (range[0].summary !== 'Ran ps') throw new Error('should be the middle record')
})

// ---- AuditLedger: chain verification ----
test('verify: empty ledger is valid', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  const result = ledger.verify()
  if (!result.valid) throw new Error('empty ledger should be valid')
})

test('verify: valid chain passes', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  ledger.append({ kind: 'agent_run_start', actor: 'olu', target: 'web-01', summary: 'Run started' })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls' })
  ledger.append({ kind: 'agent_run_end', actor: 'olu', target: 'web-01', summary: 'Run completed' })
  const result = ledger.verify()
  if (!result.valid) throw new Error(`should be valid: ${result.detail}`)
})

test('verify: detects tampered content', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls' })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ps' })
  // Tamper with the first record.
  const records = ledger.list()
  records[0].summary = 'Ran rm -rf /'
  const result = ledger.verify()
  if (result.valid) throw new Error('should detect tampered content')
  if (result.brokenAt !== 1) throw new Error(`should break at seq 1, got ${result.brokenAt}`)
})

test('verify: detects tampered hash', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls' })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ps' })
  // Tamper with the first record's hash.
  const records = ledger.list()
  records[0].hash = 'a'.repeat(64)
  const result = ledger.verify()
  if (result.valid) throw new Error('should detect tampered hash')
})

test('verify: detects tampered prevHash', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls' })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ps' })
  // Tamper with the second record's prevHash.
  const records = ledger.list()
  records[1].prevHash = 'b'.repeat(64)
  const result = ledger.verify()
  if (result.valid) throw new Error('should detect tampered prevHash')
  if (result.brokenAt !== 2) throw new Error(`should break at seq 2, got ${result.brokenAt}`)
})

// ---- AuditLedger: export/import ----
test('export/import: round-trip preserves the chain', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  ledger.append({ kind: 'agent_run_start', actor: 'olu', target: 'web-01', summary: 'Run started' })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls' })
  const json = ledger.export()

  const restored = new AuditLedger({ now: () => 2000 })
  const result = restored.import(json)
  if (!result.valid) throw new Error(`import should be valid: ${result.detail}`)
  if (result.imported !== 2) throw new Error('should import 2 records')
  if (restored.size() !== 2) throw new Error('should have 2 records')
  if (restored.verify().valid !== true) throw new Error('restored chain should be valid')
})

test('import: rejects tampered chain', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls' })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ps' })
  const json = ledger.export()

  // Tamper with the exported JSON.
  const parsed = JSON.parse(json)
  parsed[0].summary = 'Tampered'
  const tampered = JSON.stringify(parsed)

  const restored = new AuditLedger({ now: () => 2000 })
  const result = restored.import(tampered)
  if (result.valid) throw new Error('should reject tampered chain')
  if (result.imported !== 0) throw new Error('should import 0 records')
})

test('tip: returns genesis for empty, latest hash otherwise', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  if (ledger.tip() !== '0'.repeat(64)) throw new Error('empty should return genesis')
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls' })
  const tip = ledger.tip()
  if (tip === '0'.repeat(64)) throw new Error('should not be genesis after append')
  if (tip !== ledger.list()[0].hash) throw new Error('tip should be the latest hash')
})

// ---- computeRecordHash ----
test('computeRecordHash: deterministic for same input', () => {
  const h1 = computeRecordHash('command_executed', 'agent', 'web-01', 'Ran ls', undefined, 1000, 1)
  const h2 = computeRecordHash('command_executed', 'agent', 'web-01', 'Ran ls', undefined, 1000, 1)
  if (h1 !== h2) throw new Error('should be deterministic')
})

test('computeRecordHash: differs for different input', () => {
  const h1 = computeRecordHash('command_executed', 'agent', 'web-01', 'Ran ls', undefined, 1000, 1)
  const h2 = computeRecordHash('command_executed', 'agent', 'web-01', 'Ran ps', undefined, 1000, 1)
  if (h1 === h2) throw new Error('should differ for different summary')
})

// ---- EvidenceSealer ----
test('computeMerkleRoot: empty list returns genesis', () => {
  if (computeMerkleRoot([]) !== '0'.repeat(64)) throw new Error('empty should be genesis')
})

test('computeMerkleRoot: single hash returns itself', () => {
  const h = 'a'.repeat(64)
  if (computeMerkleRoot([h]) !== h) throw new Error('single should return itself')
})

test('computeMerkleRoot: two hashes produce a combined hash', () => {
  const root = computeMerkleRoot(['a'.repeat(64), 'b'.repeat(64)])
  if (root === 'a'.repeat(64) || root === 'b'.repeat(64)) throw new Error('should be combined')
  if (root.length !== 64) throw new Error('should be 64 hex chars')
})

test('computeMerkleRoot: odd number of hashes duplicates the last', () => {
  const root3 = computeMerkleRoot(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)])
  if (root3.length !== 64) throw new Error('should be 64 hex chars')
})

test('verifyMerkleRoot: valid root passes', () => {
  const hashes = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]
  const root = computeMerkleRoot(hashes)
  if (!verifyMerkleRoot(hashes, root)) throw new Error('should verify')
})

test('verifyMerkleRoot: tampered hashes fail', () => {
  const hashes = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]
  const root = computeMerkleRoot(hashes)
  const tampered = ['a'.repeat(64), 'x'.repeat(64), 'c'.repeat(64)]
  if (verifyMerkleRoot(tampered, root)) throw new Error('should fail for tampered hashes')
})

// ---- EvidenceSealer: seal + verify ----
test('seal: produces a bundle with correct metadata', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  ledger.append({ kind: 'agent_run_start', actor: 'olu', target: 'web-01', summary: 'Run started', at: 1000 })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls', at: 2000 })
  ledger.append({ kind: 'agent_run_end', actor: 'olu', target: 'web-01', summary: 'Run completed', at: 3000 })

  const sealer = new EvidenceSealer({ now: () => 5000 })
  const bundle = sealer.seal(ledger, 'seal-001')
  if (bundle.recordCount !== 3) throw new Error('should seal 3 records')
  if (bundle.fromAt !== 1000) throw new Error('fromAt')
  if (bundle.toAt !== 3000) throw new Error('toAt')
  if (bundle.sealedAt !== 5000) throw new Error('sealedAt')
  if (bundle.sealId !== 'seal-001') throw new Error('sealId')
  if (bundle.recordHashes.length !== 3) throw new Error('should have 3 record hashes')
  if (bundle.tipHash !== ledger.tip()) throw new Error('tipHash should match ledger tip')
})

test('seal + verify: valid bundle verifies against original records', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls' })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ps' })

  const sealer = new EvidenceSealer({ now: () => 5000 })
  const bundle = sealer.seal(ledger)
  const result = sealer.verify(bundle, ledger.list())
  if (!result.valid) throw new Error(`should verify: ${result.detail}`)
})

test('seal + verify: detects tampered records', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls' })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ps' })

  const sealer = new EvidenceSealer({ now: () => 5000 })
  const bundle = sealer.seal(ledger)

  // Tamper with a record.
  const tampered = ledger.list()
  tampered[0].hash = 'x'.repeat(64)
  const result = sealer.verify(bundle, tampered)
  if (result.valid) throw new Error('should detect tampered records')
})

test('seal + verify: detects missing records', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls' })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ps' })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran df' })

  const sealer = new EvidenceSealer({ now: () => 5000 })
  const bundle = sealer.seal(ledger)

  // Remove a record.
  const partial = ledger.list().slice(0, 2)
  const result = sealer.verify(bundle, partial)
  if (result.valid) throw new Error('should detect missing records')
})

test('seal: empty ledger produces a valid empty bundle', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  const sealer = new EvidenceSealer({ now: () => 5000 })
  const bundle = sealer.seal(ledger)
  if (bundle.recordCount !== 0) throw new Error('should have 0 records')
  if (bundle.recordHashes.length !== 0) throw new Error('should have 0 hashes')
  const result = sealer.verify(bundle, [])
  if (!result.valid) throw new Error('empty bundle should verify')
})

test('listBundles: returns all sealed bundles', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls' })
  const sealer = new EvidenceSealer({ now: () => 5000 })
  sealer.seal(ledger, 'seal-1')
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ps' })
  sealer.seal(ledger, 'seal-2')
  const bundles = sealer.listBundles()
  if (bundles.length !== 2) throw new Error('should have 2 bundles')
  if (bundles[1].recordCount !== 2) throw new Error('second bundle should have 2 records')
})

test('latest: returns the most recent bundle', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls' })
  const sealer = new EvidenceSealer({ now: () => 5000 })
  sealer.seal(ledger, 'seal-1')
  sealer.seal(ledger, 'seal-2')
  const latest = sealer.latest()
  if (!latest || latest.sealId !== 'seal-2') throw new Error('should return latest')
})

// ---- AuditLedger: all event kinds ----
test('append: all event kinds are accepted', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  const kinds = [
    'agent_run_start', 'agent_run_end', 'command_evaluated', 'command_approved',
    'command_denied', 'command_executed', 'mop_plan', 'mop_approve', 'mop_run',
    'mop_rollback', 'playbook_step', 'trigger_fired', 'netdata_alert',
    'aperf_deepdive', 'config_change', 'incident_created', 'incident_updated',
    'evidence_sealed',
  ] as const
  for (const kind of kinds) {
    const r = ledger.append({ kind, actor: 'test', target: 'test', summary: `${kind} test` })
    if (r.kind !== kind) throw new Error(`should accept ${kind}`)
  }
  if (ledger.size() !== kinds.length) throw new Error(`should have ${kinds.length} records`)
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
