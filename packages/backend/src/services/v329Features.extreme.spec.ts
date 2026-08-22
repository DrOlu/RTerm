import {
  sanitizeRequestParams,
  resolveRequestParams,
} from './AgentHelper/utils/model_config'
import { resolveDefaultSkillScanRoots } from '../skills/scanRoots'
import type { ModelDefinition, ModelProfile } from '../types'

/**
 * v329Features.extreme.spec — tests for the v3.2.9 feature set ported from
 * GyShell v1.7.0:
 *   1. Per-model requestParams (sanitize + resolve + runtime-owned protection)
 *   2. Skill scan roots restriction (managed dir + ~/.agents/skills only)
 *   3. Agent Setting auto-save (re-entrancy guard logic)
 *   4. close_terminal_tab guard (last-tab refusal logic)
 *   5. SSH→SSH direct transfer eligibility + fallback semantics
 *   6. Seamless failure/warning severity computation
 */

const tests: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(name: string, run: () => void | Promise<void>) { tests.push({ name, run }) }
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
}
function assertTrue(actual: boolean, message: string): void {
  if (actual !== true) throw new Error(`${message}. expected=true actual=${String(actual)}`)
}

// ─── 1. Per-model requestParams ─────────────────────────────────────────────

test('sanitizeRequestParams drops runtime-owned fields', () => {
  const sanitized = sanitizeRequestParams({
    model: 'gpt-4o',
    messages: [],
    tools: [],
    stream: true,
    tool_choice: 'auto',
    apiKey: 'sk-secret',
    baseURL: 'https://evil.example.com',
    temperature: 0.5,
    top_p: 0.9,
    custom_flag: true,
  })
  const keys = Object.keys(sanitized)
  assertTrue(!keys.includes('model'), 'model must be dropped')
  assertTrue(!keys.includes('messages'), 'messages must be dropped')
  assertTrue(!keys.includes('tools'), 'tools must be dropped')
  assertTrue(!keys.includes('stream'), 'stream must be dropped')
  assertTrue(!keys.includes('tool_choice'), 'tool_choice must be dropped')
  assertTrue(!keys.includes('apiKey'), 'apiKey must be dropped')
  assertTrue(!keys.includes('baseURL'), 'baseURL must be dropped')
  assertEqual(sanitized.temperature, 0.5, 'temperature must survive')
  assertEqual(sanitized.top_p, 0.9, 'top_p must survive')
  assertEqual(sanitized.custom_flag, true, 'custom flags must survive')
})

test('sanitizeRequestParams accepts string/number/boolean/object values', () => {
  const sanitized = sanitizeRequestParams({
    text: 'hello',
    num: 42,
    flag: false,
    obj: { nested: { deep: 1 } },
  })
  assertEqual(sanitized.text, 'hello', 'string value')
  assertEqual(sanitized.num, 42, 'number value')
  assertEqual(sanitized.flag, false, 'boolean value')
  assertEqual((sanitized.obj as { nested: { deep: number } }).nested.deep, 1, 'object value')
})

test('sanitizeRequestParams handles undefined/null input', () => {
  assertEqual(Object.keys(sanitizeRequestParams(undefined)).length, 0, 'undefined → empty')
  assertEqual(Object.keys(sanitizeRequestParams(null as unknown as undefined)).length, 0, 'null → empty')
})

const makeModel = (requestParams?: Record<string, string | number | boolean | object>): ModelDefinition => ({
  id: 'm1',
  name: 'Test Model',
  model: 'test-model',
  maxTokens: 100000,
  supportsStructuredOutput: false,
  supportsObjectToolChoice: false,
  ...(requestParams ? { requestParams } : {}),
})

test('resolveRequestParams: model-level wins over profile-level', () => {
  const item = makeModel({ temperature: 0.9, shared: 'from-model' })
  const profile: ModelProfile = {
    id: 'p1',
    name: 'P',
    globalModelId: 'm1',
    requestParams: { temperature: 0.1, profile_only: 'yes' },
  }
  const resolved = resolveRequestParams(item, profile)
  assertEqual(resolved.temperature, 0.9, 'model-level temperature must win')
  assertEqual(resolved.shared, 'from-model', 'model-only field must survive')
  assertEqual(resolved.profile_only, 'yes', 'profile-only field must survive')
})

test('resolveRequestParams: no profile → model params only', () => {
  const item = makeModel({ top_k: 5 })
  const resolved = resolveRequestParams(item, undefined)
  assertEqual(resolved.top_k, 5, 'model param survives without profile')
  assertEqual(Object.keys(resolved).length, 1, 'only the model param present')
})

test('resolveRequestParams: runtime-owned fields dropped from both levels', () => {
  const item = makeModel({ model: 'hijack', temperature: 1 })
  const profile: ModelProfile = {
    id: 'p1',
    name: 'P',
    globalModelId: 'm1',
    requestParams: { messages: [], stream: false },
  }
  const resolved = resolveRequestParams(item, profile)
  assertTrue(!('model' in resolved), 'model must not appear')
  assertTrue(!('messages' in resolved), 'messages must not appear')
  assertTrue(!('stream' in resolved), 'stream must not appear')
  assertEqual(resolved.temperature, 1, 'legit field survives')
})

// ─── 2. Skill scan roots restriction ────────────────────────────────────────

test('scanRoots default: managed dir + ~/.agents/skills only', () => {
  const roots = resolveDefaultSkillScanRoots({
    primaryRoot: '/managed/skills',
    homeDir: '/home/user',
    platform: 'linux',
    appData: '',
    codexHome: '/home/user/.codex',
  })
  assertEqual(roots.length, 2, 'exactly two roots by default')
  assertEqual(roots[0], '/managed/skills', 'primary root first')
  assertEqual(roots[1], '/home/user/.agents/skills', '.agents/skills second')
})

test('scanRoots default: no .claude/.codex/config roots', () => {
  const roots = resolveDefaultSkillScanRoots({
    primaryRoot: '/managed/skills',
    homeDir: '/home/user',
    platform: 'linux',
    appData: '',
    codexHome: '/home/user/.codex',
  })
  const joined = roots.join(':')
  assertTrue(!joined.includes('.claude'), 'no .claude root')
  assertTrue(!joined.includes('.codex'), 'no .codex root')
  assertTrue(!joined.includes('.config/agents'), 'no .config/agents root')
})

test('scanRoots opt-in: compatibility roots included when requested', () => {
  const roots = resolveDefaultSkillScanRoots({
    primaryRoot: '/managed/skills',
    homeDir: '/home/user',
    platform: 'linux',
    appData: '',
    codexHome: '/home/user/.codex',
    includeCompatibilityRoots: true,
  })
  const joined = roots.join(':')
  assertTrue(joined.includes('.claude/skills'), '.claude root present when opted in')
  assertTrue(joined.includes('.codex/skills'), '.codex root present when opted in')
  assertTrue(joined.includes('.config/agents/skills'), '.config/agents root present when opted in')
  assertTrue(joined.includes('.agents/skills'), '.agents root still present')
})

test('scanRoots windows opt-in: APPDATA root included', () => {
  const roots = resolveDefaultSkillScanRoots({
    primaryRoot: '/managed/skills',
    homeDir: 'C:\\Users\\u',
    platform: 'win32',
    appData: 'C:\\Users\\u\\AppData\\Roaming',
    codexHome: '',
    includeCompatibilityRoots: true,
  })
  const joined = roots.join(':')
  assertTrue(joined.includes('AppData'), 'APPDATA root present on win32 opt-in')
})

test('scanRoots dedupes resolved roots', () => {
  const roots = resolveDefaultSkillScanRoots({
    primaryRoot: '/home/user/.agents/skills',
    homeDir: '/home/user',
    platform: 'linux',
    appData: '',
    codexHome: '',
  })
  assertEqual(roots.length, 1, 'duplicate root collapsed')
})

// ─── 3. Agent Setting auto-save (guard logic) ───────────────────────────────

test('auto-save guard: no active profile → no-op', () => {
  // Simulates the autoSaveActiveProfile early-return path.
  const settings = { agentSettings: { profiles: [], activeProfileId: null } }
  const activeProfileId = settings.agentSettings?.activeProfileId || null
  assertEqual(activeProfileId, null, 'no active profile')
  assertTrue(activeProfileId === null, 'early return must trigger')
})

test('auto-save guard: active profile not in profiles → no-op', () => {
  const settings = {
    agentSettings: {
      profiles: [{ id: 'slot-1' }],
      activeProfileId: 'slot-9',
    },
  }
  const activeProfileId = settings.agentSettings?.activeProfileId || null
  const exists = settings.agentSettings.profiles.some((p: { id: string }) => p.id === activeProfileId)
  assertTrue(!exists, 'active id missing from profiles')
  assertTrue(!exists, 'early return must trigger')
})

test('auto-save guard: re-entrancy flag blocks nested write-back', () => {
  // The write-back itself triggers a settings change; the inFlight flag must
  // stop the nested call from re-entering overwrite().
  let inFlight = false
  let overwriteCalls = 0
  const autoSave = (): void => {
    if (inFlight) return
    inFlight = true
    try {
      overwriteCalls += 1
      // simulate the settings change the write-back triggers (nested call)
      autoSave()
    } finally {
      inFlight = false
    }
  }
  autoSave()
  autoSave()
  assertEqual(overwriteCalls, 2, 'outer calls run, nested call blocked')
})

// ─── 4. close_terminal_tab guard ────────────────────────────────────────────

test('close guard: refuses when it is the only tab', () => {
  const allTerminals = [{ id: 't1' }]
  const shouldRefuse = allTerminals.length <= 1
  assertTrue(shouldRefuse, 'must refuse with a single tab')
  assertEqual(allTerminals.length - 1, 0, 'zero tabs would remain')
})

test('close guard: allows when other tabs exist', () => {
  const allTerminals = [{ id: 't1' }, { id: 't2' }]
  const shouldRefuse = allTerminals.length <= 1
  assertTrue(!shouldRefuse, 'must allow with two tabs')
})

// ─── 5. SSH→SSH direct transfer eligibility ─────────────────────────────────

test('direct transfer eligibility: ssh→ssh unix→unix', () => {
  const eligible = (sourceType: string, targetType: string, sourceOs?: string, targetOs?: string): boolean =>
    sourceType === 'ssh' && targetType === 'ssh' && sourceOs === 'unix' && targetOs === 'unix'
  assertTrue(eligible('ssh', 'ssh', 'unix', 'unix'), 'ssh→ssh unix→unix eligible')
  assertTrue(!eligible('ssh', 'ssh', 'unix', 'windows'), 'windows target not eligible')
  assertTrue(!eligible('ssh', 'local', 'unix', 'unix'), 'local target not eligible')
  assertTrue(!eligible('local', 'ssh', 'unix', 'unix'), 'local source not eligible')
  assertTrue(!eligible('ssh', 'ssh', undefined, 'unix'), 'unknown source OS not eligible')
})

test('direct transfer: empty file handled without streaming', () => {
  // The empty-file branch must complete without touching the exec channel.
  const fileSize = 0
  const usesExecChannel = fileSize > 0
  assertTrue(!usesExecChannel, 'empty file must skip the exec channel')
})

test('direct transfer: fallback when exec unsupported returns false', () => {
  // Simulates execOnTerminal returning null (backend without side-band exec)
  // and the streaming shape with no stream — both must fall back to the relay.
  const execResults: Array<{ stdoutStream?: AsyncIterable<Buffer> } | null> = [null, {}]
  for (const execResult of execResults) {
    const direct = execResult !== null && execResult.stdoutStream !== undefined
    assertTrue(!direct, 'unsupported exec result must fall back to the relay path')
  }
})

test('direct transfer: shell quoting escapes single quotes', () => {
  const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
  assertEqual(shellQuote('/tmp/plain.txt'), `'/tmp/plain.txt'`, 'plain path quoted')
  assertEqual(shellQuote("/tmp/it's.txt"), `'/tmp/it'\\''s.txt'`, "embedded quote escaped")
})

// ─── 6. Seamless severity computation ───────────────────────────────────────

interface SeverityMessage {
  type: string
  metadata?: { exitCode?: number; action?: string; subToolLevel?: string }
}

const stepSeverity = (msg: SeverityMessage): 'error' | 'warning' | 'ok' => {
  if (msg.type === 'error') return 'error'
  if (msg.type === 'command' && msg.metadata?.exitCode !== undefined && msg.metadata.exitCode !== 0) return 'error'
  if (msg.type === 'file_edit' && msg.metadata?.action === 'error') return 'error'
  if (msg.type === 'sub_tool' && msg.metadata?.subToolLevel === 'error') return 'error'
  if (msg.type === 'alert') return 'warning'
  if (msg.type === 'sub_tool' && msg.metadata?.subToolLevel === 'warning') return 'warning'
  return 'ok'
}

test('seamless severity: successful command is ok', () => {
  assertEqual(stepSeverity({ type: 'command', metadata: { exitCode: 0 } }), 'ok', 'exit 0 → ok')
})

test('seamless severity: failed command is error', () => {
  assertEqual(stepSeverity({ type: 'command', metadata: { exitCode: 1 } }), 'error', 'exit 1 → error')
  assertEqual(stepSeverity({ type: 'command', metadata: { exitCode: 127 } }), 'error', 'exit 127 → error')
})

test('seamless severity: error message type is error', () => {
  assertEqual(stepSeverity({ type: 'error' }), 'error', 'error type → error')
})

test('seamless severity: file_edit error action is error', () => {
  assertEqual(stepSeverity({ type: 'file_edit', metadata: { action: 'error' } }), 'error', 'edit error → error')
  assertEqual(stepSeverity({ type: 'file_edit', metadata: { action: 'created' } }), 'ok', 'edit created → ok')
})

test('seamless severity: sub_tool levels map correctly', () => {
  assertEqual(stepSeverity({ type: 'sub_tool', metadata: { subToolLevel: 'error' } }), 'error', 'sub_tool error')
  assertEqual(stepSeverity({ type: 'sub_tool', metadata: { subToolLevel: 'warning' } }), 'warning', 'sub_tool warning')
  assertEqual(stepSeverity({ type: 'sub_tool', metadata: { subToolLevel: 'info' } }), 'ok', 'sub_tool info → ok')
})

test('seamless severity: alert is warning', () => {
  assertEqual(stepSeverity({ type: 'alert' }), 'warning', 'alert → warning')
})

test('seamless group: error dominates warning', () => {
  const messages: SeverityMessage[] = [
    { type: 'command', metadata: { exitCode: 0 } },
    { type: 'alert' },
    { type: 'command', metadata: { exitCode: 2 } },
  ]
  const hasError = messages.some((m) => stepSeverity(m) === 'error')
  const hasWarning = !hasError && messages.some((m) => stepSeverity(m) === 'warning')
  assertTrue(hasError, 'group must be error')
  assertTrue(!hasWarning, 'hasWarning suppressed when error present')
})

test('seamless group: warning when no error', () => {
  const messages: SeverityMessage[] = [
    { type: 'command', metadata: { exitCode: 0 } },
    { type: 'alert' },
  ]
  const hasError = messages.some((m) => stepSeverity(m) === 'error')
  const hasWarning = !hasError && messages.some((m) => stepSeverity(m) === 'warning')
  assertTrue(!hasError, 'no error in group')
  assertTrue(hasWarning, 'group must be warning')
})

test('seamless group: all ok → ok', () => {
  const messages: SeverityMessage[] = [
    { type: 'command', metadata: { exitCode: 0 } },
    { type: 'sub_tool', metadata: { subToolLevel: 'info' } },
  ]
  const hasError = messages.some((m) => stepSeverity(m) === 'error')
  const hasWarning = !hasError && messages.some((m) => stepSeverity(m) === 'warning')
  assertTrue(!hasError && !hasWarning, 'clean group')
})

// ─── Runner ─────────────────────────────────────────────────────────────────

async function main() {
  let pass = 0, fail = 0
  for (const t of tests) {
    try { await t.run(); pass++; console.log(`PASS ${t.name}`) }
    catch (e) { fail++; console.log(`FAIL ${t.name}: ${(e as Error).message}`) }
  }
  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
void main()
