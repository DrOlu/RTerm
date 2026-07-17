import { parsePuttyReg, puttySessionsToEntries, importPuttyReg } from './puttyImport'

const cases: Array<{ name: string; run: () => void }> = []
function test(n: string, r: () => void) { cases.push({ name: n, run: r }) }

const SAMPLE_REG = `Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\core-rtr-01]
"HostName"="10.0.0.1"
"PortNumber"=dword:00000016
"UserName"="admin"
"Protocol"="ssh"
"PublicKeyFile"="C:\\\\keys\\\\id_rsa.ppk"

[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Data%20Center\\dist-sw-01]
"HostName"="10.0.0.2"
"PortNumber"=dword:00000016
"UserName"="operator"
"Protocol"="ssh"

[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\console-line]
"HostName"="/dev/ttyUSB0"
"Protocol"="serial"
"Speed"=dword:00009600
`

test('parsePuttyReg extracts ssh sessions only', () => {
  const s = parsePuttyReg(SAMPLE_REG)
  if (!s['core-rtr-01']) throw new Error('missing core-rtr-01')
  if (s['core-rtr-01'].HostName !== '10.0.0.1') throw new Error('host')
  if (s['core-rtr-01'].PortNumber !== 22) throw new Error('port should be 22 (0x16), got ' + s['core-rtr-01'].PortNumber)
  if (s['core-rtr-01'].Protocol !== 'ssh') throw new Error('protocol')
})

test('URL-encoded session names are decoded to last segment', () => {
  const s = parsePuttyReg(SAMPLE_REG)
  if (!s['dist-sw-01']) throw new Error('expected decoded name dist-sw-01, got keys: ' + Object.keys(s).join(','))
})

test('puttySessionsToEntries skips non-ssh protocols', () => {
  const s = parsePuttyReg(SAMPLE_REG)
  const entries = puttySessionsToEntries(s)
  if (entries.some((e) => e.name === 'console-line')) throw new Error('serial session should be skipped')
  if (entries.length !== 2) throw new Error('expected 2 ssh entries, got ' + entries.length)
})

test('entries carry host/port/user and default authMethod', () => {
  const entries = puttySessionsToEntries(parsePuttyReg(SAMPLE_REG))
  const core = entries.find((e) => e.name === 'core-rtr-01')!
  if (core.host !== '10.0.0.1') throw new Error('host')
  if (core.port !== 22) throw new Error('port')
  if (core.username !== 'admin') throw new Error('user')
  if (core.authMethod !== 'password') throw new Error('authMethod')
  if (!core.notes?.includes('Imported from PuTTY')) throw new Error('notes')
})

test('entries get stable ids from session name', () => {
  const entries = puttySessionsToEntries(parsePuttyReg(SAMPLE_REG))
  if (!entries[0].id.startsWith('putty-')) throw new Error('id prefix')
})

test('importPuttyReg one-shot works', () => {
  const entries = importPuttyReg(SAMPLE_REG, { idPrefix: 'put' })
  if (entries.length !== 2) throw new Error('count')
  if (!entries[0].id.startsWith('put-')) throw new Error('prefix')
})

test('empty reg produces no entries', () => {
  if (importPuttyReg('').length !== 0) throw new Error('expected empty')
})

test('session with no hostname is skipped', () => {
  const reg = `[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\empty]
"Protocol"="ssh"
`
  if (importPuttyReg(reg).length !== 0) throw new Error('expected no entries for hostname-less session')
})

function main() {
  let pass = 0, fail = 0
  for (const c of cases) {
    try { c.run(); pass++; console.log(`PASS ${c.name}`) }
    catch (e: any) { fail++; console.log(`FAIL ${c.name}: ${e?.message ?? e}`) }
  }
  console.log(`\n${pass}/${cases.length} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
void main()
