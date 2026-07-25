import { BUILTIN_TOOL_INFO } from '../prompts'
import { TOOLS_FOR_MODEL } from '../tools'
import { buildBuiltInToolStatusSummary } from '../../Gateway/toolingSummary'
import { getEnabledBuiltInTools } from '../utils/model_config'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function ok(v: unknown, m = '') { if (!v) throw new Error(m || 'expected truthy') }

const modelToolNames = (TOOLS_FOR_MODEL as Array<{ function?: { name?: string } }>)
  .map((t) => t.function?.name)
  .filter((n): n is string => !!n)

// Every dispatchable tool is visible in the UI catalog (no invisible tools).
test('every tool the agent can dispatch is in BUILTIN_TOOL_INFO (visible in the tools section)', () => {
  const catalog = BUILTIN_TOOL_INFO.map((t) => t.name)
  const invisible = modelToolNames.filter((n) => !catalog.includes(n))
  ok(invisible.length === 0, `invisible tools: ${invisible.join(', ')}`)
})

// Every catalog entry surfaces in the tools:getBuiltIn summary the UI renders.
test('every dispatchable tool appears in buildBuiltInToolStatusSummary', () => {
  const summary = buildBuiltInToolStatusSummary(undefined).map((t) => t.name)
  const missing = modelToolNames.filter((n) => !summary.includes(n))
  ok(missing.length === 0, `not in summary: ${missing.join(', ')}`)
})

// Only intentionally-dangerous tools default to disabled; everything else defaults to enabled.
test('only the known-dangerous tools default to disabled', () => {
  const KNOWN_DEFAULT_DISABLED = new Set(['copy_between_tabs', 'read_file_transfer_status'])
  const summary = buildBuiltInToolStatusSummary(undefined)
  const disabled = summary.filter((t) => modelToolNames.includes(t.name) && !t.enabled).map((t) => t.name)
  const unexpected = disabled.filter((n) => !KNOWN_DEFAULT_DISABLED.has(n))
  ok(unexpected.length === 0, `unexpected default-disabled tools: ${unexpected.join(', ')}`)
})

// The agent's enabled-tool list includes every dispatchable tool when nothing is toggled off.
test('getEnabledBuiltInTools({}) keeps every dispatchable tool', () => {
  const enabled = (getEnabledBuiltInTools(TOOLS_FOR_MODEL as unknown as any[], {}) as Array<{ function?: { name?: string } }>)
    .map((t) => t.function?.name)
  const missing = modelToolNames.filter((n) => !enabled.includes(n))
  ok(missing.length === 0, `dropped by enabled filter: ${missing.join(', ')}`)
})

// The 9 observability tools specifically are visible (regression for v2.9.2 gap).
test('the 9 observability tools are all visible', () => {
  const obs = ['get_metrics', 'manage_secret', 'manage_oncall', 'get_cost', 'manage_recording', 'manage_gitops', 'manage_playbook_version', 'get_cloud_inventory', 'get_live_dashboard']
  const catalog = BUILTIN_TOOL_INFO.map((t) => t.name)
  const missing = obs.filter((n) => !catalog.includes(n))
  ok(missing.length === 0, `observability tools not visible: ${missing.join(', ')}`)
})

// The previously-invisible file/skill tools are visible (regression for the v2.9.3 audit).
test('write_file, edit_file, skill, create_skill are visible', () => {
  const catalog = BUILTIN_TOOL_INFO.map((t) => t.name)
  for (const n of ['write_file', 'edit_file', 'skill', 'create_skill']) {
    ok(catalog.includes(n), `${n} not in catalog`)
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
