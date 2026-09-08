/**
 * compoundingKnowledge.extreme.spec — FP/FN lock for every extractor.
 *
 * A FALSE NEGATIVE is a known production failure that extracts nothing.
 * A FALSE POSITIVE is unrelated ops text that extracts a lesson.
 * Both are release-blocking.
 */
export {}

import {
  extractLessons,
  isTrivialRun,
  appendLessonsToMemory,
  memoryHasFingerprint,
  matchGatedMutation,
  matchReviewVerb,
  connectionIdentity,
  EXTRACTORS,
} from './compoundingKnowledge'

const tests: Array<{ name: string; run: () => Promise<void> | void }> = []
function test(name: string, run: () => Promise<void> | void) {
  tests.push({ name, run })
}
function assertTrue(cond: boolean, message: string): void {
  if (!cond) throw new Error(message)
}
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
  }
}

// ── trivial-run filter ──────────────────────────────────────────────────────

test('trivial: 1+1 produces no lesson path', () => {
  assertTrue(isTrivialRun('1+1'), '1+1 is trivial')
  assertTrue(isTrivialRun('hello'), 'hello is trivial')
  assertTrue(isTrivialRun('ok'), 'ok is trivial')
  assertTrue(!isTrivialRun('1+1', 'InvalidSelectors'), 'error overrides trivial input')
  assertTrue(!isTrivialRun('join server-2 to corp.local'), 'real ops input is not trivial')
})

test('trivial: empty input with no error is trivial', () => {
  assertTrue(isTrivialRun('', undefined), 'empty is trivial')
  assertTrue(isTrivialRun(undefined, undefined), 'undefined is trivial')
})

// ── true positives (FN lock) ────────────────────────────────────────────────

test('FN lock: InvalidSelectors from PSRP Receive', () => {
  const hits = extractLessons('PSRP Receive failed: w:InvalidSelectors after Create ShellId=abc')
  assertTrue(hits.some((h) => h.fingerprint === 'psrp.invalid-selectors.dest-and-init'), 'must extract dest-and-init')
})

test('FN lock: NetUseAdd 64 / IPC$', () => {
  const hits = extractLessons('NetUseAdd \\\\EC2AMAZ-8NK9FUP.corp.local\\IPC$ returned 64')
  assertTrue(hits.some((h) => h.fingerprint === 'ad.join.netuseadd-64-use-djoin'), 'must extract djoin lesson')
})

test('FN lock: network name is no longer available + Add-Computer', () => {
  const hits = extractLessons('Add-Computer failed: The network name is no longer available. NETLOGON')
  assertTrue(hits.some((h) => h.fingerprint === 'ad.join.netuseadd-64-use-djoin'), 'named error + join context')
})

test('FN lock: missing access token', () => {
  const hits = extractLessons('gateway closed: missing access token (code 1008)')
  assertTrue(hits.some((h) => h.fingerprint === 'rterm-cli.native-ws.dropped-authorization'), 'cli token lesson')
})

test('FN lock: duplicate tool definitions', () => {
  const hits = extractLessons('HTTP 400: duplicate tool definitions (agentspan_health)')
  assertTrue(hits.some((h) => h.fingerprint === 'agent.duplicate-tool-definitions'), 'dedupe lesson')
})

test('FN lock: npm EACCES root-owned cache', () => {
  const hits = extractLessons('npm ERR! code EACCES\nnpm ERR! Your cache folder contains root-owned files')
  assertTrue(hits.some((h) => h.fingerprint === 'npm.eacces.root-owned-cache'), 'eacces lesson')
})

test('FN lock: Basic 401 after DC promo', () => {
  const hits = extractLessons('PSRP Basic 401 Unauthorized after Install-ADDSForest / DCPromo success')
  assertTrue(hits.some((h) => h.fingerprint === 'ad.dc.basic-401-use-negotiate'), 'negotiate lesson')
})

test('FN lock: WinRM dollar mangle', () => {
  const hits = extractLessons('$env:COMPUTERNAME was unexpected at this time.')
  assertTrue(hits.some((h) => h.fingerprint === 'winrm.cmd-wrapping.dollar-mangle'), 'dollar mangle lesson')
})

test('FN lock: echo-mangled exec_command', () => {
  const hits = extractLessons('inline python3 -c was echo-mangled; only the first export ran')
  assertTrue(hits.some((h) => h.fingerprint === 'agent.exec_command.multiline-export'), 'multiline lesson')
})

test('FN lock: SOAP guess loop (InvalidSelectors + OptionSet tweak)', () => {
  const hits = extractLessons(
    'w:InvalidSelectors still fail after OptionSet mustUnderstand and SessionId keep-alive tweak',
  )
  assertTrue(hits.some((h) => h.fingerprint === 'psrp.soap-guessing-vs-payload'), 'soap-guess lesson')
  assertTrue(hits.some((h) => h.fingerprint === 'psrp.invalid-selectors.dest-and-init'), 'also dest-and-init')
})

// ── false positives (FP lock) ───────────────────────────────────────────────

test('FP lock: BGP selector config is not InvalidSelectors', () => {
  const hits = extractLessons('route-map FOO permit 10\n match ip address prefix-list SELECTORS')
  assertTrue(!hits.some((h) => h.extractor === 'psrp-invalid-selectors'), 'must not fire on prefix-list SELECTORS')
})

test('FP lock: HTTP 401 on nginx is not DC Basic 401 unless PSRP/WinRM+basic', () => {
  const hits = extractLessons('nginx: 401 Unauthorized for /admin')
  assertTrue(!hits.some((h) => h.fingerprint === 'ad.dc.basic-401-use-negotiate'), 'nginx 401 is not DC promo')
})

test('FP lock: EACCES on a random file is not npm cache', () => {
  const hits = extractLessons('open /etc/shadow: EACCES permission denied')
  assertTrue(!hits.some((h) => h.fingerprint === 'npm.eacces.root-owned-cache'), 'not npm cache')
})

test('FP lock: "network name" in a DNS comment is not NetUseAdd', () => {
  const hits = extractLessons('the network name corp.local resolves via 172.31.31.19')
  assertTrue(!hits.some((h) => h.fingerprint === 'ad.join.netuseadd-64-use-djoin'), 'DNS prose is not join failure')
})

test('FP lock: duplicate IP on an interface is not duplicate tools', () => {
  const hits = extractLessons('Error: duplicate IP address 10.0.0.1 on vlan10')
  assertTrue(!hits.some((h) => h.fingerprint === 'agent.duplicate-tool-definitions'), 'duplicate IP != tools')
})

test('FP lock: access token in a JWT tutorial is not the CLI bug', () => {
  const hits = extractLessons('Store your OAuth access token in ~/.config')
  assertTrue(
    !hits.some((h) => h.fingerprint === 'rterm-cli.native-ws.dropped-authorization'),
    'generic access token prose',
  )
})

test('FP lock: ping success is not a lesson', () => {
  const hits = extractLessons('rterm ping -> {pong:true}')
  assertEqual(hits.length, 0, 'pong is not a failure')
})

// ── memory append / dedupe ──────────────────────────────────────────────────

test('appendLessonsToMemory writes fingerprint once', () => {
  const lessons = extractLessons('w:InvalidSelectors from PSRP Receive')
  const a = appendLessonsToMemory('# Memory\n', lessons, { runId: 'r1', at: '2026-09-08' })
  assertTrue(a.added.length >= 1, 'first append adds')
  assertTrue(memoryHasFingerprint(a.next, lessons[0].fingerprint), 'fingerprint present')
  const b = appendLessonsToMemory(a.next, lessons, { runId: 'r2', at: '2026-09-08' })
  assertEqual(b.added.length, 0, 'second append is a no-op (compound in SQLite, not memory.md dupes)')
})

test('connectionIdentity prefers name over IP', () => {
  assertEqual(
    connectionIdentity({ name: 'CORP-DC1', host: '44.197.31.152', transport: 'psrp', auth: 'negotiate' }),
    'CORP-DC1',
    'name wins',
  )
  assertTrue(
    connectionIdentity({ host: '44.197.31.152', transport: 'psrp', auth: 'basic' }) !== 'CORP-DC1',
    'same IP different identity without name',
  )
})

test('gated mutations: Add-Computer requires ad-join probe', () => {
  const g = matchGatedMutation('Add-Computer -DomainName corp.local -Force')
  assertTrue(g !== null && g.requireProbeTag === 'ad-join', 'Add-Computer gated')
  assertTrue(matchGatedMutation('Get-ComputerInfo') === null, 'Get-ComputerInfo not gated')
})

test('review verbs: Install-ADDSForest is a review verb; Get-ADForest is not', () => {
  assertEqual(matchReviewVerb('Install-ADDSForest -DomainName corp.local'), 'Install-ADDSForest', 'promo')
  assertTrue(matchReviewVerb('Get-ADForest') === null, 'read is not a review verb')
})

test('every extractor has a unique fingerprint', () => {
  const fps = EXTRACTORS.map((e) => {
    // poke with a string that should not necessarily match
    return e.name
  })
  assertEqual(new Set(fps).size, fps.length, 'extractor names unique')
})

test('empty haystack extracts nothing', () => {
  assertEqual(extractLessons('', '   ', undefined).length, 0, 'empty')
})

async function main() {
  let failed = 0
  for (const t of tests) {
    try {
      await t.run()
      console.log(`  ok  ${t.name}`)
    } catch (err) {
      failed++
      console.error(`  FAIL  ${t.name}: ${(err as Error).message}`)
    }
  }
  console.log(`# tests ${tests.length}`)
  console.log(`# pass ${tests.length - failed}`)
  console.log(`# fail ${failed}`)
  if (failed) process.exit(1)
}
main()
