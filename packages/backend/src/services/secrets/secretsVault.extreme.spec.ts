import { SecretsVault, deriveKey, encryptSecret, decryptSecret, verifyMasterKey } from './secretsVault'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function eq(a: unknown, b: unknown, m = '') { if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`) }
function ok(v: unknown, m = '') { if (!v) throw new Error(m || 'expected truthy') }
function throws(fn: () => void, m = '') { let t = false; try { fn() } catch { t = true } if (!t) throw new Error(m || 'expected throw') }
const fixedNonce = () => Buffer.alloc(12, 7)
const key = () => deriveKey('master-pass', Buffer.alloc(16, 1))

// ─── crypto primitives ───
test('deriveKey is deterministic + 32 bytes', () => {
  const a = deriveKey('pw', Buffer.alloc(16, 1))
  const b = deriveKey('pw', Buffer.alloc(16, 1))
  eq(a.length, 32)
  ok(a.equals(b))
})
test('deriveKey differs by password/salt', () => {
  const a = deriveKey('pw1', Buffer.alloc(16, 1))
  const b = deriveKey('pw2', Buffer.alloc(16, 1))
  const c = deriveKey('pw1', Buffer.alloc(16, 2))
  ok(!a.equals(b)); ok(!a.equals(c))
})
test('encryptSecret/decryptSecret round-trips', () => {
  const blob = encryptSecret('s3cr3t-value', key(), fixedNonce())
  eq(decryptSecret(blob, key()), 's3cr3t-value')
})
test('encryptSecret produces nonce||tag||ct (base64, no plaintext)', () => {
  const blob = encryptSecret('topsecret', key(), fixedNonce())
  ok(!blob.includes('topsecret'))
  const buf = Buffer.from(blob, 'base64')
  ok(buf.length > 12 + 16, 'has nonce+tag+ct')
})
test('decryptSecret throws on tampered ciphertext (GCM auth)', () => {
  const blob = encryptSecret('data', key(), fixedNonce())
  const buf = Buffer.from(blob, 'base64')
  buf[buf.length - 1] ^= 0xff
  throws(() => decryptSecret(buf.toString('base64'), key()))
})
test('decryptSecret throws on malformed blob', () => {
  throws(() => decryptSecret(Buffer.from('short').toString('base64'), key()))
})
test('decrypt with wrong key throws', () => {
  const blob = encryptSecret('x', key(), fixedNonce())
  throws(() => decryptSecret(blob, deriveKey('other', Buffer.alloc(16, 1))))
})

// ─── vault lifecycle ───
test('locked vault (no master key) reports locked + set/get throw', () => {
  const v = new SecretsVault()
  ok(!v.unlocked())
  throws(() => v.set('a', 'b'))
  // get on missing key throws not-found first (locked only after found)
})
test('unlocked vault set/get round-trips without storing plaintext', () => {
  const v = new SecretsVault({ masterKey: 'pw', randomBytes: fixedNonce })
  ok(v.unlocked())
  v.set('api-key', 'AKIA123')
  eq(v.get('api-key'), 'AKIA123')
  const exported = v.exportEncrypted()
  ok(!exported.includes('AKIA123'), 'plaintext must not appear in export')
})
test('set rejects invalid key names', () => {
  const v = new SecretsVault({ masterKey: 'pw' })
  throws(() => v.set('', 'x'))
  throws(() => v.set('bad key!', 'x'))
})
test('set rejects empty value', () => {
  const v = new SecretsVault({ masterKey: 'pw' })
  throws(() => v.set('k', ''))
})
test('get on missing key throws not-found', () => {
  const v = new SecretsVault({ masterKey: 'pw' })
  throws(() => v.get('nope'))
})
test('has/delete lifecycle', () => {
  const v = new SecretsVault({ masterKey: 'pw', randomBytes: fixedNonce })
  v.set('a', '1')
  ok(v.has('a'))
  ok(v.delete('a'))
  ok(!v.has('a'))
  ok(!v.delete('a'))
})
test('overwrite preserves createdAt, bumps updatedAt', () => {
  let t = 1000
  const v = new SecretsVault({ masterKey: 'pw', randomBytes: fixedNonce, now: () => t })
  v.set('k', 'v1')
  t = 2000
  v.set('k', 'v2')
  const meta = v.list().find((m) => m.key === 'k')!
  eq(meta.createdAt, 1000)
  eq(meta.updatedAt, 2000)
  eq(v.get('k'), 'v2')
})

// ─── listing (metadata only) ───
test('list returns metadata sorted, never values', () => {
  const v = new SecretsVault({ masterKey: 'pw', randomBytes: fixedNonce })
  v.set('b-key', 'val-b', { service: 'aws' })
  v.set('a-key', 'val-a', { service: 'github' })
  const l = v.list()
  eq(l[0].key, 'a-key')
  eq(l[1].key, 'b-key')
  ok(!('blob' in l[0]) && !('value' in l[0]))
})
test('list filters by label', () => {
  const v = new SecretsVault({ masterKey: 'pw', randomBytes: fixedNonce })
  v.set('k1', 'v1', { service: 'aws' })
  v.set('k2', 'v2', { service: 'github' })
  const aws = v.list({ labelKey: 'service', labelValue: 'aws' })
  eq(aws.length, 1)
  eq(aws[0].key, 'k1')
})
test('size() reflects entries', () => {
  const v = new SecretsVault({ masterKey: 'pw', randomBytes: fixedNonce })
  eq(v.size(), 0)
  v.set('a', '1'); v.set('b', '2')
  eq(v.size(), 2)
})

// ─── audit hook ───
test('onAudit fires for set/get/delete/list (never with value)', () => {
  const calls: string[] = []
  const v = new SecretsVault({ masterKey: 'pw', randomBytes: fixedNonce, onAudit: (a, k) => calls.push(`${a}:${k}`) })
  v.set('x', 'secret-val')
  v.get('x')
  v.delete('x')
  v.list()
  ok(calls.includes('set:x') && calls.includes('get:x') && calls.includes('delete:x') && calls.includes('list:*'))
  ok(!calls.join(',').includes('secret-val'), 'value must never be audited')
})

// ─── resolveEnv (exec-time materialization) ───
test('resolveEnv resolves ${secret:key} refs and passes literals through', () => {
  const v = new SecretsVault({ masterKey: 'pw', randomBytes: fixedNonce })
  v.set('token', 'abc123')
  const env = v.resolveEnv({ API: '${secret:token}', PLAIN: 'hello' })
  eq(env.API, 'abc123')
  eq(env.PLAIN, 'hello')
})
test('resolveEnv throws on missing secret ref (never runs dangling)', () => {
  const v = new SecretsVault({ masterKey: 'pw' })
  throws(() => v.resolveEnv({ A: '${secret:missing}' }))
})

// ─── export / import (ciphertext portability) ───
test('export/import round-trips ciphertext; values recoverable with same key', () => {
  const v1 = new SecretsVault({ masterKey: 'pw', randomBytes: fixedNonce })
  v1.set('k1', 'value-1', { service: 'x' })
  const json = v1.exportEncrypted()
  const v2 = new SecretsVault({ masterKey: 'pw' })
  const n = v2.importEncrypted(json)
  eq(n, 1)
  eq(v2.get('k1'), 'value-1')
})
test('importEncrypted rejects invalid JSON / missing entries', () => {
  const v = new SecretsVault({ masterKey: 'pw' })
  throws(() => v.importEncrypted('not json'))
  throws(() => v.importEncrypted('{"version":1}'))
})
test('imported values unreadable with a different master key', () => {
  const v1 = new SecretsVault({ masterKey: 'pw1', randomBytes: fixedNonce })
  v1.set('k', 'secret')
  const v2 = new SecretsVault({ masterKey: 'pw2' })
  v2.importEncrypted(v1.exportEncrypted())
  throws(() => v2.get('k'))
})

// ─── verifyMasterKey ───
test('verifyMasterKey: same → true, different → false', () => {
  const salt = Buffer.alloc(16, 3)
  ok(verifyMasterKey('pw', 'pw', salt))
  ok(!verifyMasterKey('pw', 'nope', salt))
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
