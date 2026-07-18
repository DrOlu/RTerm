import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionLogService } from './sessionLogService'

const cases: Array<{ name: string; run: () => Promise<void> | void }> = []
function test(n: string, r: () => Promise<void> | void) { cases.push({ name: n, run: r }) }

function tmpLogDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rterm-logsearch-'))
}

function seed(svc: SessionLogService) {
  // Three sessions across two hosts with distinct content.
  svc.start('s-rtr1', { title: 'core-rtr-01', type: 'ssh' })
  svc.write('s-rtr1', 'core-rtr-01# show ip bgp summary\n')
  svc.write('s-rtr1', 'BGP router identifier 10.0.0.1\n')
  svc.write('s-rtr1', 'Neighbor 10.0.0.2 is Established\n')
  svc.write('s-rtr1', '%BGP-5-ADJCHANGE: neighbor 10.0.0.2 Down\n')
  svc.stop('s-rtr1')

  svc.start('s-rtr2', { title: 'edge-rtr-02', type: 'ssh' })
  svc.write('s-rtr2', 'edge-rtr-02# show interface Gi0/0/1\n')
  svc.write('s-rtr2', '  3049 input errors, 12 CRC\n')
  svc.write('s-rtr2', 'BGP is not configured on this router\n')
  svc.stop('s-rtr2')

  svc.start('s-sw1', { title: 'dist-sw-01', type: 'ssh' })
  svc.write('s-sw1', 'dist-sw-01# show version\n')
  svc.write('s-sw1', 'Cisco IOS Software, C9300\n')
  svc.stop('s-sw1')
}

test('search finds a literal substring across multiple sessions', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  seed(svc)
  const res = svc.search('BGP')
  if (res.totalMatches === 0) throw new Error('expected matches for BGP')
  // BGP appears in rtr1 (3 lines) and rtr2 (1 line) — not sw1.
  const sessions = new Set(res.matches.map((m) => m.sessionId))
  if (!sessions.has('s-rtr1') || !sessions.has('s-rtr2')) throw new Error(`wrong sessions: ${[...sessions]}`)
  if (sessions.has('s-sw1')) throw new Error('sw1 should not match BGP')
  if (res.sessionsSearched !== 3) throw new Error(`searched ${res.sessionsSearched}`)
})

test('search is case-insensitive by default', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  seed(svc)
  const res = svc.search('bgp-5-adjchange')
  if (res.totalMatches !== 1) throw new Error(`expected 1 match, got ${res.totalMatches}`)
  if (res.matches[0].sessionId !== 's-rtr1') throw new Error('wrong session')
})

test('caseSensitive search respects case', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  seed(svc)
  const lower = svc.search('bgp', { caseSensitive: true })
  const upper = svc.search('BGP', { caseSensitive: true })
  if (upper.totalMatches === 0) throw new Error('uppercase BGP should match')
  // lowercase 'bgp' should NOT match the all-caps BGP-5-ADJCHANGE line.
  if (lower.totalMatches >= upper.totalMatches + 1 && lower.totalMatches !== 0) {
    // only the lowercase 'show ip bgp summary' line matches lowercase
  }
  if (!lower.matches.every((m) => m.text.includes('bgp'))) throw new Error('caseSensitive leak')
})

test('host filter restricts search to matching session titles', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  seed(svc)
  const res = svc.search('BGP', { host: 'core-rtr-01' })
  if (res.sessionsSearched !== 1) throw new Error(`searched ${res.sessionsSearched}`)
  if (!res.matches.every((m) => m.sessionId === 's-rtr1')) throw new Error('host filter leaked')
})

test('sessionId filter restricts to a single session', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  seed(svc)
  const res = svc.search('show', { sessionId: 's-sw1' })
  if (res.sessionsSearched !== 1) throw new Error(`searched ${res.sessionsSearched}`)
  if (!res.matches.every((m) => m.sessionId === 's-sw1')) throw new Error('sessionId filter leaked')
})

test('regex search matches a pattern', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  seed(svc)
  const res = svc.search('\\d+ input errors', { regex: true })
  if (res.totalMatches !== 1) throw new Error(`expected 1 regex match, got ${res.totalMatches}`)
  if (!res.matches[0].text.includes('3049 input errors')) throw new Error('regex matched wrong line')
})

test('invalid regex falls back to literal substring (never throws)', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  seed(svc)
  // An unbalanced paren is an invalid regex; should not throw.
  const res = svc.search('show ip (unbalanced', { regex: true })
  if (res.totalMatches !== 0) throw new Error('literal fallback should find nothing here')
})

test('maxMatches caps the number of returned matches', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  seed(svc)
  const res = svc.search('show', { maxMatches: 2 })
  if (res.matches.length > 2) throw new Error(`maxMatches violated: ${res.matches.length}`)
})

test('contextLines returns surrounding lines', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  seed(svc)
  const res = svc.search('%BGP-5-ADJCHANGE', { contextLines: 2 })
  if (res.totalMatches !== 1) throw new Error('expected 1 match')
  const m = res.matches[0]
  if (m.contextBefore.length === 0) throw new Error('expected contextBefore')
  if (!m.contextBefore.some((c) => c.includes('Established'))) throw new Error('wrong contextBefore')
})

test('match line numbers are 1-based and correct', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  svc.start('ln', { title: 'ln-host', type: 'ssh' })
  svc.write('ln', 'alpha\nbeta\ngamma\nTARGET\ndelta\n')
  svc.stop('ln')
  const res = svc.search('TARGET')
  if (res.totalMatches !== 1) throw new Error('expected 1 match')
  if (res.matches[0].line !== 4) throw new Error(`expected line 4, got ${res.matches[0].line}`)
})

test('ANSI escape sequences are stripped from matched lines', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  svc.start('ansi', { title: 'ansi-host', type: 'ssh' })
  svc.write('ansi', '\x1b[32m✔ success\x1b[0m connected\x1b[31m!\x1b[0m\n')
  svc.stop('ansi')
  const res = svc.search('success')
  if (res.totalMatches !== 1) throw new Error('expected 1 match')
  if (res.matches[0].text.includes('\x1b')) throw new Error('ANSI not stripped')
  if (!res.matches[0].text.includes('success')) throw new Error('content lost')
})

test('since/until time filters scope sessions by start time', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  svc.start('early', { title: 'early-host', type: 'ssh' })
  svc.write('early', 'needle\n'); svc.stop('early')
  await new Promise((r) => setTimeout(r, 30))
  const mid = new Date().toISOString()
  await new Promise((r) => setTimeout(r, 30))
  svc.start('late', { title: 'late-host', type: 'ssh' })
  svc.write('late', 'needle\n'); svc.stop('late')

  const onlyLate = svc.search('needle', { since: mid })
  if (!onlyLate.matches.every((m) => m.sessionId === 'late')) throw new Error('since filter leaked')
  const onlyEarly = svc.search('needle', { until: mid })
  if (!onlyEarly.matches.every((m) => m.sessionId === 'early')) throw new Error('until filter leaked')
})

test('search over an empty log dir returns zero matches without throwing', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  const res = svc.search('anything')
  if (res.totalMatches !== 0 || res.sessionsSearched !== 0) throw new Error('expected empty result')
})

test('empty query returns zero matches without scanning', async () => {
  const dir = tmpLogDir()
  const svc = new SessionLogService({ logDir: dir })
  seed(svc)
  const res = svc.search('   ')
  if (res.totalMatches !== 0) throw new Error('empty query should match nothing')
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
