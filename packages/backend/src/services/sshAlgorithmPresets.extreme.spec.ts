import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

/**
 * Verify the legacy + cisco algorithm presets include every algorithm ssh2
 * actually supports at runtime (so old Cisco/embedded devices that only offer
 * legacy crypto can connect), and that NO offered algorithm is one ssh2 would
 * reject with "Unsupported algorithm".
 *
 * resolveSshAlgorithms is module-private, so we read the presets straight from
 * the source text and validate against ssh2's SUPPORTED_* sets.
 */

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, 'SSHBackend.ts'), 'utf8')

const consts = createRequire(import.meta.url)('ssh2/lib/protocol/constants.js') as Record<string, string[]>
const SUPPORTED_KEX = new Set(consts.SUPPORTED_KEX ?? [])
const SUPPORTED_HOSTKEY = new Set(consts.SUPPORTED_SERVER_HOST_KEY ?? [])
const SUPPORTED_CIPHER = new Set(consts.SUPPORTED_CIPHER ?? [])
const SUPPORTED_MAC = new Set(consts.SUPPORTED_MAC ?? [])

// Extract an array literal from the source for a given preset block + field.
function extract(preset: 'LEGACY_ALGORITHMS' | 'CISCO_ALGORITHMS', field: 'kex' | 'serverHostKey' | 'cipher' | 'hmac'): string[] {
  const start = src.indexOf(`const ${preset}`)
  if (start < 0) throw new Error(`preset ${preset} not found in source`)
  const end = src.indexOf('\n};', start)
  const block = src.slice(start, end)
  const fieldStart = block.indexOf(`${field}: [`)
  if (fieldStart < 0) throw new Error(`field ${field} not found in ${preset}`)
  const fieldEnd = block.indexOf(']', fieldStart)
  const arrText = block.slice(fieldStart, fieldEnd)
  const names = [...arrText.matchAll(/'([^']+)'/g)].map((m) => m[1])
  return names
}

const REQUIRED_LEGACY = {
  kex: ['diffie-hellman-group1-sha1', 'diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256', 'curve25519-sha256', 'ecdh-sha2-nistp256'],
  serverHostKey: ['ssh-rsa', 'ssh-dss', 'rsa-sha2-256', 'rsa-sha2-512', 'ssh-ed25519'],
  cipher: ['aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc', 'aes128-ctr', 'aes128-gcm', 'chacha20-poly1305@openssh.com'],
  hmac: ['hmac-sha1', 'hmac-sha1-96', 'hmac-md5', 'hmac-md5-96', 'hmac-ripemd160', 'hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1-etm@openssh.com', 'hmac-sha2-256-96', 'hmac-sha2-512-96'],
}
const REQUIRED_CISCO = {
  kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group-exchange-sha256'],
  serverHostKey: ['ssh-rsa', 'ssh-dss'],
  cipher: ['aes128-cbc', 'aes256-cbc', '3des-cbc', 'aes128-ctr'],
  hmac: ['hmac-sha1', 'hmac-md5', 'hmac-ripemd160', 'hmac-sha2-256', 'hmac-sha1-etm@openssh.com'],
}

test('legacy preset contains all required legacy kex algorithms', () => {
  const got = extract('LEGACY_ALGORITHMS', 'kex')
  for (const a of REQUIRED_LEGACY.kex) {
    if (!got.includes(a)) throw new Error(`legacy kex missing ${a}`)
  }
})
test('legacy preset contains group-exchange + group15-18 KEX variants', () => {
  const got = extract('LEGACY_ALGORITHMS', 'kex')
  for (const a of ['diffie-hellman-group-exchange-sha1', 'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group15-sha512', 'diffie-hellman-group16-sha512', 'diffie-hellman-group17-sha512', 'diffie-hellman-group18-sha512']) {
    if (!got.includes(a)) throw new Error(`legacy kex missing ${a}`)
  }
})
test('legacy preset contains all required legacy host key types (incl ecdsa-384/521)', () => {
  const got = extract('LEGACY_ALGORITHMS', 'serverHostKey')
  for (const a of [...REQUIRED_LEGACY.serverHostKey, 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521']) {
    if (!got.includes(a)) throw new Error(`legacy hostkey missing ${a}`)
  }
})
test('legacy preset contains all required legacy ciphers', () => {
  const got = extract('LEGACY_ALGORITHMS', 'cipher')
  for (const a of REQUIRED_LEGACY.cipher) {
    if (!got.includes(a)) throw new Error(`legacy cipher missing ${a}`)
  }
})
test('legacy preset contains ripemd160 + etm + -96 MACs', () => {
  const got = extract('LEGACY_ALGORITHMS', 'hmac')
  for (const a of REQUIRED_LEGACY.hmac) {
    if (!got.includes(a)) throw new Error(`legacy hmac missing ${a}`)
  }
})

test('cisco preset contains all required cisco kex (incl group-exchange)', () => {
  const got = extract('CISCO_ALGORITHMS', 'kex')
  for (const a of REQUIRED_CISCO.kex) {
    if (!got.includes(a)) throw new Error(`cisco kex missing ${a}`)
  }
})
test('cisco preset contains all required cisco ciphers + MACs', () => {
  const c = extract('CISCO_ALGORITHMS', 'cipher')
  const h = extract('CISCO_ALGORITHMS', 'hmac')
  for (const a of REQUIRED_CISCO.cipher) if (!c.includes(a)) throw new Error(`cisco cipher missing ${a}`)
  for (const a of REQUIRED_CISCO.hmac) if (!h.includes(a)) throw new Error(`cisco hmac missing ${a}`)
})

// Every offered algorithm MUST be one ssh2 actually supports (else ssh2 throws).
test('every kex offered by legacy preset is supported by ssh2 (no crash)', () => {
  for (const a of extract('LEGACY_ALGORITHMS', 'kex')) {
    if (!SUPPORTED_KEX.has(a)) throw new Error(`legacy kex offers unsupported algorithm: ${a}`)
  }
})
test('every host key offered by legacy preset is supported by ssh2', () => {
  for (const a of extract('LEGACY_ALGORITHMS', 'serverHostKey')) {
    if (!SUPPORTED_HOSTKEY.has(a)) throw new Error(`legacy hostkey offers unsupported algorithm: ${a}`)
  }
})
test('every cipher offered by legacy preset is supported by ssh2', () => {
  for (const a of extract('LEGACY_ALGORITHMS', 'cipher')) {
    if (!SUPPORTED_CIPHER.has(a)) throw new Error(`legacy cipher offers unsupported algorithm: ${a}`)
  }
})
test('every MAC offered by legacy preset is supported by ssh2', () => {
  for (const a of extract('LEGACY_ALGORITHMS', 'hmac')) {
    if (!SUPPORTED_MAC.has(a)) throw new Error(`legacy hmac offers unsupported algorithm: ${a}`)
  }
})
test('every kex offered by cisco preset is supported by ssh2', () => {
  for (const a of extract('CISCO_ALGORITHMS', 'kex')) {
    if (!SUPPORTED_KEX.has(a)) throw new Error(`cisco kex offers unsupported algorithm: ${a}`)
  }
})
test('every cipher offered by cisco preset is supported by ssh2', () => {
  for (const a of extract('CISCO_ALGORITHMS', 'cipher')) {
    if (!SUPPORTED_CIPHER.has(a)) throw new Error(`cisco cipher offers unsupported algorithm: ${a}`)
  }
})
test('every MAC offered by cisco preset is supported by ssh2', () => {
  for (const a of extract('CISCO_ALGORITHMS', 'hmac')) {
    if (!SUPPORTED_MAC.has(a)) throw new Error(`cisco hmac offers unsupported algorithm: ${a}`)
  }
})
test('every host key offered by cisco preset is supported by ssh2', () => {
  for (const a of extract('CISCO_ALGORITHMS', 'serverHostKey')) {
    if (!SUPPORTED_HOSTKEY.has(a)) throw new Error(`cisco hostkey offers unsupported algorithm: ${a}`)
  }
})

// RC4/blowfish/cast must NOT be offered (Node OpenSSL 3 lacks them; ssh2 would throw).
test('RC4/blowfish/cast ciphers are NOT offered (would crash on OpenSSL 3 hosts)', () => {
  for (const preset of ['LEGACY_ALGORITHMS', 'CISCO_ALGORITHMS'] as const) {
    const c = extract(preset, 'cipher')
    for (const bad of ['arcfour', 'arcfour128', 'arcfour256', 'blowfish-cbc', 'cast128-cbc']) {
      if (c.includes(bad)) throw new Error(`${preset} must not offer ${bad} (crashes on OpenSSL 3 hosts)`)
    }
  }
})

// Modern-first ordering: strong algorithms come before legacy ones so newer images prefer them.
test('legacy kex lists curve25519 before group1-sha1 (modern-first)', () => {
  const got = extract('LEGACY_ALGORITHMS', 'kex')
  if (got.indexOf('curve25519-sha256') > got.indexOf('diffie-hellman-group1-sha1')) {
    throw new Error('legacy kex not modern-first')
  }
})
test('legacy cipher lists CTR/GCM before CBC (modern-first)', () => {
  const got = extract('LEGACY_ALGORITHMS', 'cipher')
  if (got.indexOf('aes128-ctr') > got.indexOf('aes128-cbc')) {
    throw new Error('legacy cipher not modern-first')
  }
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
