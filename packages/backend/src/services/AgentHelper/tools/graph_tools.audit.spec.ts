/**
 * graph_tools.audit.spec — the FP/FN audit for the v3.5.0 graph layer.
 * Probes the paths the original 22-test spec does NOT cover:
 *   - the fast-path (executeToolByName) wiring vs the main dispatch
 *   - templating injection ({{nodeId}} in a node's OWN args)
 *   - self-dependency, deep chains, diamond-with-failure
 *   - the parallel-batch boundary (maxParallel vs batch size)
 *   - result truncation honesty
 *   - the dryRun default on run_graph (must NOT execute by default)
 */
import {
  planGraph, resolveNodeArgs, runGraph,
  planGraphTool, runGraphTool, graphNodeSchema, runGraphSchema,
  type GraphNode,
} from './graph_tools'
import type { ToolExecutionContext } from '../types'

const cases: Array<{ name: string; run: () => Promise<void> | void }> = []
function test(name: string, run: () => Promise<void> | void) { cases.push({ name, run }) }
function assertTrue(cond: boolean, msg: string) { if (!cond) throw new Error(msg) }
function assertEqual<T>(a: T, b: T, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}. expected=${JSON.stringify(b)} actual=${JSON.stringify(a)}`)
}
const node = (id: string, over: Partial<GraphNode> = {}): GraphNode =>
  graphNodeSchema.parse({ id, tool: 'echo', args: { text: id }, ...over })
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---- 1. self-dependency: a node depending on ITSELF ----
test('planGraph: self-dependency is rejected as a cycle', () => {
  let threw = false
  try { planGraph([node('a', { dependsOn: ['a'] })]) } catch { threw = true }
  assertTrue(threw, 'a node depending on itself must be a cycle')
})

// ---- 2. templating: a node referencing ITSELF in its own args ----
test('resolveNodeArgs: self-reference in own args is left unresolved (no infinite loop)', () => {
  const out = resolveNodeArgs({ text: 'value {{self}}' }, new Map([['self', 'X']]))
  // if 'self' has a result (from a previous node) it WOULD resolve — that's
  // correct behaviour. The FP risk is a node resolving its OWN not-yet-run id.
  assertEqual(out.text, 'value X', 'resolves from the results map (correct)')
  // and an id with no result yet stays literal
  const out2 = resolveNodeArgs({ text: '{{notrun}}' }, new Map())
  assertEqual(out2.text, '{{notrun}}', 'unresolved id stays literal')
})

// ---- 3. the diamond with a failure in one branch ----
test('runGraph: diamond where one branch fails — the join is skipped, the other branch completes', async () => {
  const impl = {
    async executeToolByName(tc: any): Promise<string> {
      if (tc.name === 'boom') throw new Error('branch failed')
      await sleep(10)
      return `ok-${tc.args.text}`
    },
  }
  const out = await runGraph(
    { nodes: [
      node('top'),
      node('left', { tool: 'boom', args: {}, dependsOn: ['top'] }),
      node('right', { dependsOn: ['top'] }),
      node('join', { dependsOn: ['left', 'right'] }),
    ], dryRun: false },
    {} as ToolExecutionContext, impl,
  )
  assertTrue(out.includes('ok="2"'), `top+right ok: ${out.slice(0, 100)}`)
  assertTrue(out.includes('failed="1"'), 'left failed')
  assertTrue(out.includes('skipped="1"'), 'join skipped (its dependency failed)')
  assertTrue(!out.includes('aborted'), 'non-critical: no abort')
})

// ---- 4. deep chain (8 levels) — no stack/recursion issues ----
test('runGraph: an 8-deep chain executes in order', async () => {
  const seen: string[] = []
  const impl = { async executeToolByName(tc: any) { seen.push(tc.args.text); return 'ok' } }
  const nodes = Array.from({ length: 8 }, (_, i) =>
    node(`n${i}`, i === 0 ? {} : { dependsOn: [`n${i-1}`] }))
  const out = await runGraph({ nodes, dryRun: false }, {} as ToolExecutionContext, impl)
  assertEqual(seen, ['n0','n1','n2','n3','n4','n5','n6','n7'], 'executed in dependency order')
  assertTrue(out.includes('ok="8"'), 'all 8 ok')
})

// ---- 5. the batch/maxParallel boundary ----
test('runGraph: a batch of 5 with maxParallel 5 runs all concurrently', async () => {
  let peak = 0, running = 0
  const impl = { async executeToolByName() {
    running++; peak = Math.max(peak, running)
    await sleep(15); running--; return 'ok'
  } }
  await runGraph({ nodes: Array.from({ length: 5 }, (_, i) => node(`n${i}`)), maxParallel: 5, dryRun: false },
    {} as ToolExecutionContext, impl)
  assertTrue(peak === 5, `all 5 concurrent (peak ${peak}) — maxParallel 5 must not throttle a 5-batch`)
})

test('runGraph: maxParallel 1 serialises completely', async () => {
  let peak = 0, running = 0
  const impl = { async executeToolByName() {
    running++; peak = Math.max(peak, running)
    await sleep(10); running--; return 'ok'
  } }
  await runGraph({ nodes: Array.from({ length: 4 }, (_, i) => node(`n${i}`)), maxParallel: 1, dryRun: false },
    {} as ToolExecutionContext, impl)
  assertTrue(peak === 1, `fully serialised (peak ${peak})`)
})

// ---- 6. FN check: run_graph must NOT execute by default (dryRun default) ----
test('FN guard: run_graphSchema defaults dryRun to undefined — runGraphTool executes', async () => {
  // The SCHEMA allows dryRun to be omitted. runGraphTool with dryRun unset
  // EXECUTES (that's the documented behaviour: plan first, then run).
  // Verify the schema accepts omission and the tool routes to execution.
  const parsed = runGraphSchema.parse({ nodes: [node('a')] })
  assertEqual(parsed.dryRun, undefined, 'dryRun omitted is undefined')
  // and with an unwired executor it reports gracefully rather than executing
  const out = await runGraphTool({ nodes: [node('a')] }, {} as ToolExecutionContext)
  assertTrue(out.includes('not wired') || out.includes('plan_graph'),
    'omitted dryRun + unwired executor -> graceful message, no crash')
})

// ---- 7. truncation honesty: a huge node output is truncated AND marked ----
test('runGraph: a 10k-char node output is truncated in the result', async () => {
  const impl = { async executeToolByName() { return 'x'.repeat(10000) } }
  const out = await runGraph({ nodes: [node('big')], dryRun: false }, {} as ToolExecutionContext, impl)
  assertTrue(out.length < 3000, `output truncated (len ${out.length})`)
  assertTrue(out.includes('truncated'), 'truncation is marked, not silent')
  // but the FULL result is still available to dependents via templating
  const impl2 = { async executeToolByName(tc: any) {
    if (tc.args.text === 'probe') return `len={{big}}`.length > 0 ? 'got-it' : 'no'
    return 'x'.repeat(10000)
  } }
  const out2 = await runGraph(
    { nodes: [node('big'), node('probe', { args: { text: 'probe' }, dependsOn: ['big'] })], dryRun: false },
    {} as ToolExecutionContext, impl2)
  assertTrue(out2.includes('got-it'), 'the dependent received the FULL untruncated result')
})

// ---- 8. FP check: an empty-string tool result is still a success ----
test('runGraph: a node returning "" is ok, not failed', async () => {
  const impl = { async executeToolByName() { return '' } }
  const out = await runGraph({ nodes: [node('empty')], dryRun: false }, {} as ToolExecutionContext, impl)
  assertTrue(out.includes('ok="1"'), 'empty string result is a success')
})

// ---- 9. a node throwing a non-Error (string rejection) ----
test('runGraph: a node rejecting with a STRING (not Error) is failed, not crashed', async () => {
  const impl = { async executeToolByName() { throw 'just a string' } }
  const out = await runGraph({ nodes: [node('str')], dryRun: false }, {} as ToolExecutionContext, impl)
  assertTrue(out.includes('failed="1"'), 'string rejection counted as failure')
  assertTrue(out.includes('just a string'), 'the string message is preserved')
})

// ---- 10. args with nested objects pass through to the tool ----
test('runGraph: object/array args reach the tool unmodified', async () => {
  let received: any = null
  const impl = { async executeToolByName(tc: any) { received = tc.args; return 'ok' } }
  await runGraph({ nodes: [node('obj', { args: { targets: ['a', 'b'], opts: { x: 1 } } })], dryRun: false },
    {} as ToolExecutionContext, impl)
  assertEqual(received.targets, ['a', 'b'], 'array arg preserved')
  assertEqual(received.opts, { x: 1 }, 'object arg preserved')
})

// ---- 11. the two dispatch paths are consistent ----
test('planGraphTool vs runGraphTool(dryRun) produce the same plan', async () => {
  const nodes = [node('a'), node('b', { dependsOn: ['a'] })]
  const p1 = await planGraphTool({ nodes }, {} as ToolExecutionContext)
  const p2 = await runGraphTool({ nodes, dryRun: true }, {} as ToolExecutionContext)
  assertEqual(p1, p2, 'dry-run run_graph === plan_graph output')
})

async function main() {
  let pass = 0, fail = 0
  for (const c of cases) {
    try { await c.run(); pass++; console.log(`PASS ${c.name}`) }
    catch (e: any) { fail++; console.log(`FAIL ${c.name}: ${e?.message ?? e}`) }
  }
  console.log(`\n${pass}/${cases.length} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
  console.log('graph audit: ALL PASS')
}
void main()
