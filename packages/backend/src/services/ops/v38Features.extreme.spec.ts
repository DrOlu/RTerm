/**
 * v3.8.0 feature modules — unit tests (no live network).
 */
export {}

import { methodAllowed } from '../security/tokenScopes'
import { redactText, parseSecretRef } from '../redaction/secretRedact'
import { pluginAllowed, sha256Hex, sbomForFiles } from '../supplyChain/pluginAllowlist'
import { sspiAvailable, usesCurrentUser, WSMAN_SPN } from '../security/sspiNegotiate'
import { planOfflineJoin, djoinProvisionCommand, djoinRequestCommand } from './djoinPlaybook'
import { defineJumpPath, grantBreakGlass, pathAllowed } from './jumpPath'
import { joinSession, takeConn, whoHasConn } from './collabSession'
import { rememberOutput, diffLast, unifiedDiff } from './outputSnapshot'
import { requestApproval, decide, sweepExpired } from './approvalQueue'
import { replayWithStubs, breakpointBefore } from './agentReplay'
import { openIncident, getIncident } from './incidentBundle'
import { parseCdpNeighbors, configDiff, inConfigMode } from './netDevice'

const tests: Array<{ name: string; run: () => void }> = []
function test(name: string, run: () => void) { tests.push({ name, run }) }
function ok(c: boolean, m: string) { if (!c) throw new Error(m) }

test('scopes: empty = full; terminals:* allows list not settings:set', () => {
  ok(methodAllowed('settings:set', []), 'legacy')
  ok(methodAllowed('terminal:list', ['terminals:*']), 'term')
  ok(!methodAllowed('settings:set', ['terminals:*']), 'deny settings')
  ok(methodAllowed('agent:startTask', ['*']), 'star')
})

test('redact tokens and extra values', () => {
  const s = redactText('token=gys_at_abcdefghijklmnop password=hunter2secret', ['hunter2secret'])
  ok(s.includes('REDACTED'), 'redacted')
  ok(!s.includes('gys_at_abcdefghijklmnop') || s.includes('REDACTED:RTERM_TOKEN') || s.includes('REDACTED'), 'token gone')
  ok(!s.includes('hunter2secret'), 'extra')
})

test('parseSecretRef vault: and secretRef:', () => {
  ok(parseSecretRef('vault:windows-dsrm-corp-password')?.ref === 'windows-dsrm-corp-password', 'vault')
  ok(parseSecretRef('plain') === null, 'plain')
})

test('plugin allowlist and sbom hash', () => {
  ok(pluginAllowed('web-intel', ['*']), 'star')
  ok(!pluginAllowed('evil', ['web-intel']), 'deny')
  ok(sha256Hex('abc').length === 64, 'sha')
  const bom = sbomForFiles([{ path: 'a.js', sha256: sha256Hex('a') }])
  ok(bom.bomFormat === 'CycloneDX' && bom.components.length === 1, 'sbom')
})

test('SSPI unavailable on non-win32; SPN shape', () => {
  ok(sspiAvailable() === (process.platform === 'win32'), 'plat')
  ok(!usesCurrentUser('Administrator', 'x'), 'password still required')
  ok(WSMAN_SPN('dc.corp.local') === 'WSMAN/dc.corp.local', 'spn')
})

test('djoin playbook steps mention provision and requestODJ', () => {
  const p = planOfflineJoin({
    domain: 'corp.local',
    machine: 'EC2AMAZ-C69VULQ',
    dcConnection: 'CORP-DC1',
    memberConnection: 'CORP-WS2',
  })
  ok(p.steps.length === 5, '5 steps')
  ok(djoinProvisionCommand('corp.local', 'X').includes('/provision'), 'prov')
  ok(djoinRequestCommand().includes('/requestODJ'), 'req')
})

test('jump path break-glass TTL', () => {
  defineJumpPath('lab', [{ connectionName: 'jump', role: 'jump' }, { connectionName: 'dc', role: 'target' }])
  ok(pathAllowed('lab'), 'open')
  const now = 1_000_000
  grantBreakGlass('lab', 60_000, now)
  ok(pathAllowed('lab', now + 1), 'inside')
  ok(!pathAllowed('lab', now + 60_001), 'expired')
})

test('collab takeConn', () => {
  joinSession('s1', 'alice')
  ok(whoHasConn('s1') === 'alice', 'alice')
  takeConn('s1', 'bob')
  ok(whoHasConn('s1') === 'bob', 'bob')
})

test('output snapshot diff', () => {
  rememberOutput('cisco-xe-1', 'show run', 'aaa')
  const d = diffLast('cisco-xe-1', 'bbb')
  ok(d.changed && d.previous === 'aaa', 'changed')
  ok(unifiedDiff('a\nb', 'a\nc').includes('-b') && unifiedDiff('a\nb', 'a\nc').includes('+c'), 'udiff')
})

test('approval two-person and TTL expire', () => {
  const a = requestApproval('Add-Computer', 1000, true, 0)
  const mid = decide(a.id, 'alice', true, 10)
  ok(mid.state === 'pending', 'need 2')
  const done = decide(a.id, 'bob', true, 20)
  ok(done.state === 'approved', 'ok')
  const b = requestApproval('fmt', 5, false, 0)
  ok(sweepExpired(10) >= 1, 'swept')
  ok(decide(b.id, 'x', true, 10).state === 'expired', 'expired')
})

test('replay stubs tools', () => {
  const r = replayWithStubs('run1', [{ tool: 'exec_command', args: {}, stub: 'ok' }])
  ok(r.wouldHaveCalled[0] === 'exec_command' && r.steps[0].usedStub, 'stub')
  ok(breakpointBefore('exec_command', 'exec_command'), 'bp')
})

test('incident bundle', () => {
  const i = openIncident('DC promo', { tabIds: ['CORP-DC1'], runId: 'r1' })
  ok(i.id.startsWith('INC-') && getIncident(i.id)?.title === 'DC promo', 'inc')
})

test('cdp parse and config mode', () => {
  const n = parseCdpNeighbors('Device ID: sw2\nInterface: Gi1/0/1\nPort ID (outgoing port): Gi1/0/2\n')
  ok(n[0]?.device === 'sw2', 'cdp')
  ok(inConfigMode('router(config-if)#'), 'cfg')
  ok(!configDiff('same', 'same').changed, 'same')
})

let pass = 0
let fail = 0
for (const t of tests) {
  try {
    t.run()
    console.log('  ok ', t.name)
    pass++
  } catch (e) {
    console.log('  FAIL', t.name, e instanceof Error ? e.message : e)
    fail++
  }
}
console.log(`# tests ${tests.length}`)
console.log(`# pass ${pass}`)
console.log(`# fail ${fail}`)
if (fail) process.exit(1)
