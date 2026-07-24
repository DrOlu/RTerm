import {
  PlaybookVersioning, lintPlaybook, lintOk, findDependsCycle, diffText, type PlaybookDef,
} from './playbookVersioning'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function eq(a: unknown, b: unknown, m = '') { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`) }
function ok(v: unknown, m = '') { if (!v) throw new Error(m || 'expected truthy') }
function throws(fn: () => void, m = '') { let t = false; try { fn() } catch { t = true } if (!t) throw new Error(m || 'expected throw') }
function hasRule(issues: ReturnType<typeof lintPlaybook>, rule: string, sev?: string) {
  return issues.some((i) => i.rule === rule && (!sev || i.severity === sev))
}

const good: PlaybookDef = {
  name: 'deploy',
  steps: [
    { id: 'a', kind: 'command', command: 'systemctl status nginx' },
    { id: 'b', kind: 'command', command: 'systemctl reload nginx', dependsOn: ['a'], rollback: { kind: 'command', command: 'echo revert' } },
  ],
}

// ─── lint: valid ───
test('valid playbook lints clean', () => {
  const issues = lintPlaybook(good)
  ok(!hasRule(issues, 'step-kind') && !hasRule(issues, 'depends-missing'), 'no structural errors')
  ok(lintOk(good))
})
test('lint rejects non-object / missing name / empty steps', () => {
  ok(hasRule(lintPlaybook(undefined as any), 'invalid'))
  ok(hasRule(lintPlaybook({ steps: [] } as any), 'steps'))
  ok(hasRule(lintPlaybook({ steps: [{ kind: 'command', command: 'x' }] } as any), 'name'))
})
test('lint flags invalid kind / empty command / bad wait', () => {
  ok(hasRule(lintPlaybook({ name: 'x', steps: [{ kind: 'nope' as any }] }), 'step-kind'))
  ok(hasRule(lintPlaybook({ name: 'x', steps: [{ kind: 'command', command: '  ' }] }), 'step-empty'))
  ok(hasRule(lintPlaybook({ name: 'x', steps: [{ kind: 'script' }] }), 'step-empty'))
  ok(hasRule(lintPlaybook({ name: 'x', steps: [{ kind: 'wait', waitSeconds: 0 }] }), 'step-wait'))
})
test('lint flags duplicate step ids', () => {
  ok(hasRule(lintPlaybook({ name: 'x', steps: [
    { id: 'a', kind: 'command', command: 'c1' },
    { id: 'a', kind: 'command', command: 'c2' },
  ] }), 'step-id-dup'))
})

// ─── lint: params ───
test('lint flags undefined param references', () => {
  ok(hasRule(lintPlaybook({ name: 'x', steps: [{ kind: 'command', command: 'echo {{param.region}}' }] }), 'param-undefined'))
})
test('declared params pass lint', () => {
  ok(lintOk({ name: 'x', params: [{ name: 'region' }], steps: [{ kind: 'command', command: 'echo {{param.region}}' }] }))
})

// ─── lint: dependsOn ───
test('lint flags dependsOn unknown step', () => {
  ok(hasRule(lintPlaybook({ name: 'x', steps: [{ kind: 'command', command: 'c', dependsOn: ['ghost'] }] }), 'depends-missing'))
})
test('findDependsCycle detects a cycle', () => {
  const cyc = findDependsCycle([
    { id: 'a', kind: 'command', command: 'x', dependsOn: ['b'] },
    { id: 'b', kind: 'command', command: 'x', dependsOn: ['a'] },
  ])
  ok(cyc !== null && cyc.length >= 2, 'cycle found')
})
test('findDependsCycle returns null for a DAG', () => {
  eq(findDependsCycle([
    { id: 'a', kind: 'command', command: 'x' },
    { id: 'b', kind: 'command', command: 'x', dependsOn: ['a'] },
    { id: 'c', kind: 'command', command: 'x', dependsOn: ['b'] },
  ]), null)
})
test('lint surfaces depends-cycle as error', () => {
  ok(hasRule(lintPlaybook({ name: 'x', steps: [
    { id: 'a', kind: 'command', command: 'x', dependsOn: ['b'] },
    { id: 'b', kind: 'command', command: 'x', dependsOn: ['a'] },
  ] }), 'depends-cycle', 'error'))
})

// ─── lint: rollback heuristic ───
test('mutating command without rollback → warning (not error)', () => {
  const issues = lintPlaybook({ name: 'x', steps: [{ kind: 'command', command: 'rm -rf /tmp/x' }] })
  ok(hasRule(issues, 'no-rollback', 'warning'))
  ok(lintOk({ name: 'x', steps: [{ kind: 'command', command: 'rm -rf /tmp/x' }] }), 'warning does not block')
})
test('read-only command → no rollback warning', () => {
  ok(!hasRule(lintPlaybook({ name: 'x', steps: [{ kind: 'command', command: 'systemctl status nginx' }] }), 'no-rollback'))
})

// ─── versioning ───
test('save creates sequential versions with hashes', () => {
  const v = new PlaybookVersioning({ now: () => 1000 })
  const v1 = v.save('pb', good)
  const v2 = v.save('pb', { ...good, name: 'deploy-v2' })
  eq(v1.version, 1)
  eq(v2.version, 2)
  ok(v1.hash !== v2.hash)
  eq(v.history('pb').length, 2)
})
test('save refuses a def with lint errors', () => {
  const v = new PlaybookVersioning()
  throws(() => v.save('pb', { name: 'bad', steps: [] }))
})
test('save requires a playbookId', () => {
  const v = new PlaybookVersioning()
  throws(() => v.save('', good))
})
test('latest/get return the right versions (deep-copied, mutation-safe)', () => {
  const v = new PlaybookVersioning({ now: () => 1 })
  v.save('pb', good)
  const got = v.get('pb', 1)!
  got.def.name = 'MUTATED'
  eq(v.get('pb', 1)!.def.name, 'deploy') // internal copy unaffected
  eq(v.latest('pb')!.version, 1)
})
test('rollback saves the old def as a NEW version', () => {
  const v = new PlaybookVersioning({ now: () => 1 })
  v.save('pb', good)
  v.save('pb', { ...good, name: 'v2-name' })
  const r = v.rollback('pb', 1)
  eq(r.version, 3)
  eq(r.def.name, 'deploy')
  ok(r.comment!.includes('rollback'))
})
test('rollback to a missing version throws', () => {
  const v = new PlaybookVersioning()
  v.save('pb', good)
  throws(() => v.rollback('pb', 99))
})

// ─── diffText ───
test('diffText shows -/+ changes', () => {
  const d = diffText('line1\nline2\nline3', 'line1\nlineX\nline3')
  ok(d.includes('-line2') && d.includes('+lineX'), 'shows change')
})
test('playbook diff between versions', () => {
  const v = new PlaybookVersioning({ now: () => 1 })
  v.save('pb', good)
  v.save('pb', { ...good, name: 'renamed' })
  const d = v.diff('pb', 1, 2)
  ok(d.includes('--- v1') && d.includes('+++ v2'))
  ok(d.includes('renamed'))
})
test('diff requires both versions', () => {
  const v = new PlaybookVersioning()
  v.save('pb', good)
  throws(() => v.diff('pb', 1, 5))
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
