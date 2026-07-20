import { planDag, chunk, validateDag } from './dagScheduler'
import type { PlaybookStep } from '../../types'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function step(id: string, dependsOn?: string[], kind: PlaybookStep['kind'] = 'command'): PlaybookStep {
  return { id, kind, command: 'true', ...(dependsOn ? { dependsOn } : {}) }
}

test('linear steps (no dependsOn) produce one-step batches in order', () => {
  const { batches } = planDag([step('a'), step('b'), step('c')])
  if (batches.length !== 3) throw new Error(`expected 3 batches, got ${batches.length}`)
  if (batches[0].join() !== '0' || batches[1].join() !== '1' || batches[2].join() !== '2') {
    throw new Error(`wrong order: ${JSON.stringify(batches)}`)
  }
})

test('fan-out: two independent steps (explicit dependsOn:[]) share one batch', () => {
  // a and b declare no dependency explicitly -> parallel; c joins on both
  const { batches } = planDag([step('a', []), step('b', []), step('c', ['a', 'b'])])
  if (batches.length !== 2) throw new Error(`expected 2 batches, got ${batches.length}`)
  const first = [...batches[0]].sort().join(',')
  if (first !== '0,1') throw new Error(`expected [a,b] together, got ${first}`)
  if (batches[1].join() !== '2') throw new Error('c should be last')
})

test('fan-in: join step waits for all its dependencies', () => {
  const { batches } = planDag([step('a', []), step('b', []), step('c', []), step('d', ['a', 'b', 'c'])])
  if (batches.length !== 2) throw new Error('expected 2 batches')
  if (batches[1].join() !== '3') throw new Error('join step d must be in final batch')
})

test('diamond dependency: a -> (b,c) -> d', () => {
  const { batches } = planDag([step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])])
  if (batches.length !== 3) throw new Error(`expected 3 batches, got ${batches.length}`)
  if (batches[1].slice().sort().join(',') !== '1,2') throw new Error('b and c should be parallel')
})

test('explicit dependsOn:[] (empty array) means no dependency, runs in first batch', () => {
  const { batches } = planDag([step('a', []), step('b', []), step('c', ['a', 'b'])])
  if (batches[0].slice().sort().join(',') !== '0,1') throw new Error('a and b should both be in batch 0')
})

test('cycle detection: a->b->a throws', () => {
  let err = ''
  try { planDag([step('a', ['b']), step('b', ['a'])]) } catch (e) { err = (e as Error).message }
  if (!/cycle/i.test(err)) throw new Error(`expected cycle error, got: ${err}`)
})

test('self-dependency is a cycle', () => {
  let err = ''
  try { planDag([step('a', ['a'])]) } catch (e) { err = (e as Error).message }
  if (!/cycle/i.test(err)) throw new Error(`expected cycle error for self-dep, got: ${err}`)
})

test('missing dependency id throws a clear error naming the step', () => {
  let err = ''
  try { planDag([step('a'), step('b', ['nonexistent'])]) } catch (e) { err = (e as Error).message }
  if (!/unknown step id "nonexistent"/.test(err)) throw new Error(`expected unknown-id error, got: ${err}`)
})

test('larger DAG: multi-level pipeline batches correctly', () => {
  // 0 -> 1,2 -> 3,4 -> 5
  const { batches } = planDag([
    step('s0'),
    step('s1', ['s0']), step('s2', ['s0']),
    step('s3', ['s1', 's2']), step('s4', ['s2']),
    step('s5', ['s3', 's4']),
  ])
  if (batches.length !== 4) throw new Error(`expected 4 batches, got ${batches.length}: ${JSON.stringify(batches)}`)
})

test('chunk splits a batch into capped parallel groups', () => {
  const out = chunk([1, 2, 3, 4, 5], 2)
  if (out.length !== 3 || out[0].join() !== '1,2' || out[2].join() !== '5') {
    throw new Error(`bad chunk: ${JSON.stringify(out)}`)
  }
})

test('chunk size 1 yields singletons; size > len returns one group', () => {
  if (chunk([1, 2], 1).length !== 2) throw new Error('size1')
  if (chunk([1, 2], 9).length !== 1) throw new Error('big size')
})

test('validateDag returns null for valid graph, error string for cycle', () => {
  if (validateDag([step('a'), step('b', ['a'])]) !== null) throw new Error('valid graph should be null')
  const bad = validateDag([step('a', ['b']), step('b', ['a'])])
  if (!bad || !/cycle/i.test(bad)) throw new Error(`expected cycle message, got: ${bad}`)
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
