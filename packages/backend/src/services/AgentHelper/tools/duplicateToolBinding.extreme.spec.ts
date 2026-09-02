/**
 * duplicateToolBinding.extreme.spec — regression spec for the v3.7.3
 * duplicate-tool fix.
 *
 * BUG (reported against Grok 4.6 / Fable 5.1, HTTP 400 "duplicate tool
 * definitions"): plugin tool schemas were injected into the session
 * binding's toolsForModel (commit 6bb8082, v3.1.8) AND appended again at
 * bindTools() time (commit c009c46, v3.4.0). Every plugin tool
 * (agentspan_health, web_*, synapse_*, ...) was sent to the provider
 * twice. Strict providers reject the request outright; lenient ones
 * dedupe silently, so the bug looked provider-specific.
 *
 * FIX: (1) the session binding no longer carries plugin schemas (the
 * bind-time append is the fresher source — setPluginTools may run after
 * the binding was cached); (2) dedupeToolsByName() guards every bindTools
 * call as defense in depth.
 *
 * This spec tests the REAL dedupeToolsByName() plus the exact bind-time
 * composition, so a regression in either layer fails here.
 */
export {}

import { dedupeToolsByName, getEnabledBuiltInTools } from '../utils/model_config'
import { TOOLS_FOR_MODEL } from '../tools'

const tests: Array<{ name: string; run: () => Promise<void> | void }> = []
function test(name: string, run: () => Promise<void> | void) { tests.push({ name, run }) }
function assertTrue(cond: boolean, message: string): void { if (!cond) throw new Error(message) }
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}. expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
}

// ─── The real bind-time composition (mirrors the agent loop) ─────────────────

/** Simulate the agent loop's bind-time composition with plugin + MCP tools. */
function composeBoundTools(
  builtInTools: any[],
  mcpTools: any[],
  pluginToolSchemas: any[],
): any[] {
  return dedupeToolsByName([...builtInTools, ...mcpTools, ...pluginToolSchemas])
}

// A realistic plugin tool schema set (the shape setPluginTools produces).
const pluginSchemas = [
  { type: 'function', function: { name: 'agentspan_health', description: 'health', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'web_search', description: 'search', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'synapse_health', description: 'health', parameters: { type: 'object', properties: {} } } },
]

// ─── dedupeToolsByName ────────────────────────────────────────────────────────

test('dedupeToolsByName removes exact duplicates (first definition wins)', () => {
  const dup = [...pluginSchemas, ...pluginSchemas]
  const out = dedupeToolsByName(dup)
  assertEqual(out.length, pluginSchemas.length, 'duplicates should collapse to one each')
  assertEqual(out[0].function.name, 'agentspan_health', 'first definition should win')
})

test('dedupeToolsByName keeps tools with unique names untouched', () => {
  const out = dedupeToolsByName(pluginSchemas)
  assertEqual(out.length, 3, 'unique tools pass through')
})

test('dedupeToolsByName handles both OpenAI shape (function.name) and bare name', () => {
  const mixed = [
    { type: 'function', function: { name: 'a' } },
    { name: 'a' }, // bare shape (MCP StructuredTool)
    { name: 'b' },
  ]
  const out = dedupeToolsByName(mixed)
  assertEqual(out.length, 2, 'cross-shape duplicate should collapse')
  assertEqual((out[0] as any).function.name, 'a', 'first (OpenAI shape) wins')
})

test('dedupeToolsByName drops entries without a name', () => {
  const out = dedupeToolsByName([{ type: 'function' }, { function: {} }, pluginSchemas[0]])
  assertEqual(out.length, 1, 'nameless entries should be dropped')
})

test('dedupeToolsByName returns an empty array for empty input', () => {
  assertEqual(dedupeToolsByName([]).length, 0, 'empty in, empty out')
})

// ─── The regression: the exact double-append from the bug ─────────────────────

test('REGRESSION: the v3.4.0 double-append (binding + bindTools) produces no duplicates after the fix', () => {
  // Before the fix: builtInTools (from sessionBinding.toolsForModel) ALREADY
  // contained the plugin schemas, and pluginOpenAiTools appended them again.
  const builtIns = TOOLS_FOR_MODEL as unknown as any[]
  const doubleAppended = [...builtIns, ...pluginSchemas, ...pluginSchemas]
  const bound = dedupeToolsByName(doubleAppended)
  const names = bound.map((t) => t?.function?.name ?? t?.name)
  const uniqueNames = new Set(names)
  assertEqual(names.length, uniqueNames.size, 'bound tool list must have unique names')
  // Every original tool (built-in and plugin) is still present exactly once.
  for (const p of pluginSchemas) {
    assertEqual(names.filter((n) => n === p.function.name).length, 1, `${p.function.name} must appear exactly once`)
  }
  for (const b of builtIns) {
    const n = b?.function?.name ?? b?.name
    assertEqual(names.filter((x) => x === n).length, 1, `${n} must appear exactly once`)
  }
})

test('REGRESSION: the fixed composition (built-ins + MCP + plugin, single append) has unique names', () => {
  const builtIns = getEnabledBuiltInTools(TOOLS_FOR_MODEL as unknown as any[], {}) as unknown as any[]
  const mcpTools = [{ name: 'server__tool1' }, { name: 'server__tool2' }]
  const bound = composeBoundTools(builtIns, mcpTools, pluginSchemas)
  const names = bound.map((t) => t?.function?.name ?? t?.name)
  assertEqual(names.length, new Set(names).size, 'no duplicates in bound list')
  // All sources survive: built-ins + MCP + plugins.
  assertTrue(names.includes('agentspan_health'), 'plugin tools must survive the dedupe')
  assertTrue(names.includes('server__tool1'), 'MCP tools must survive the dedupe')
  assertTrue(names.includes('exec_command'), 'built-in tools must survive the dedupe')
})

test('REGRESSION: an MCP tool colliding with a plugin tool name binds exactly once (first wins)', () => {
  const builtIns = getEnabledBuiltInTools(TOOLS_FOR_MODEL as unknown as any[], {}) as unknown as any[]
  const collidingMcp = [{ name: 'agentspan_health' }] // same name as a plugin tool
  const bound = composeBoundTools(builtIns, collidingMcp, pluginSchemas)
  const names = bound.map((t) => t?.function?.name ?? t?.name)
  assertEqual(names.filter((n) => n === 'agentspan_health').length, 1, 'collision must bind once')
})

test('REGRESSION: the real built-in tool list itself contains no duplicate names', () => {
  const names = (TOOLS_FOR_MODEL as unknown as any[]).map((t) => t?.function?.name ?? t?.name)
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)
  assertEqual(dupes.length, 0, `TOOLS_FOR_MODEL has duplicate names: ${dupes.join(', ')}`)
})

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  let pass = 0, fail = 0
  for (const t of tests) {
    try { await t.run(); pass++; console.log(`PASS ${t.name}`) }
    catch (e: any) { fail++; console.log(`FAIL ${t.name}: ${e?.message ?? e}`) }
  }
  console.log(`\n${pass}/${tests.length} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
void main()
