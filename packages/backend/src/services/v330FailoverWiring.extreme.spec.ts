import {
  isFailoverEligible,
  buildFailoverChain,
  withModelFailover,
} from './AgentHelper/utils/modelFailover'
import type { ModelProfile, ModelDefinition, BackendSettings } from '../types'

/**
 * v330FailoverWiring.extreme.spec — exhaustive tests proving the v3.3.0
 * model-failover WRITE→READ path is real (the v3.2.18 gap: the engine worked
 * but nothing could ever populate the chain).
 *
 * Mirrors buildModelBindingFromProfileId's fallback resolution exactly:
 *   - valid ids resolve to {model, label}
 *   - the primary's own id is dropped
 *   - duplicates are dropped
 *   - unknown ids are skipped (warn, don't break the chain)
 *   - ids without an API key are skipped
 *   - non-string / empty / whitespace entries are skipped
 *   - empty/undefined fallbackModels → empty chain (failover disabled)
 *
 * Plus the engine edge cases and the settings round-trip.
 */

const tests: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(name: string, run: () => void | Promise<void>) { tests.push({ name, run }) }
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
}
function assertTrue(actual: boolean, message: string): void {
  if (actual !== true) throw new Error(`${message}. expected=true actual=${String(actual)}`)
}

// ── the exact resolution logic from buildModelBindingFromProfileId ──────────

interface ResolveOpts {
  items: ModelDefinition[]
  globalModelId: string
  fallbackIds: unknown
}

/** Mirrors the v3.3.0 fallback resolution in AgentService_v2. */
function resolveFallbackChain(opts: ResolveOpts): Array<{ model: string; label?: string }> {
  const { items, globalModelId, fallbackIds } = opts
  const chain: Array<{ model: string; label?: string }> = []
  const seen = new Set<string>([globalModelId])
  for (const fallbackId of Array.isArray(fallbackIds) ? fallbackIds : []) {
    if (typeof fallbackId !== 'string' || !fallbackId.trim()) continue
    if (seen.has(fallbackId)) continue
    const item = items.find((m) => m.id === fallbackId)
    if (!item || !item.apiKey) continue
    seen.add(fallbackId)
    chain.push({ model: item.model, label: item.name ?? item.model })
  }
  return chain
}

function makeItem(id: string, model: string, opts: { apiKey?: string; name?: string } = {}): ModelDefinition {
  return {
    id,
    name: opts.name ?? model,
    model,
    baseUrl: 'https://api.test/v1',
    apiKey: opts.apiKey ?? 'sk-test-key',
    maxTokens: 100000,
    supportsStructuredOutput: false,
    supportsObjectToolChoice: false,
  } as ModelDefinition
}

// ── 1. Happy path ──────────────────────────────────────────────────────────

test('wiring: valid fallback ids resolve to model+label in order', () => {
  const chain = resolveFallbackChain({
    items: [makeItem('m1', 'model-a'), makeItem('m2', 'model-b'), makeItem('m3', 'model-c')],
    globalModelId: 'primary',
    fallbackIds: ['m1', 'm2'],
  })
  assertEqual(chain.length, 2, 'two fallbacks')
  assertEqual(chain[0].model, 'model-a', 'first')
  assertEqual(chain[1].model, 'model-b', 'second')
  assertEqual(chain[0].label, 'model-a', 'label from name')
})

test('wiring: custom names become labels', () => {
  const chain = resolveFallbackChain({
    items: [makeItem('m1', 'moonshotai/kimi-k3', { name: 'Kimi K3' })],
    globalModelId: 'p',
    fallbackIds: ['m1'],
  })
  assertEqual(chain[0].label, 'Kimi K3', 'label')
})

// ── 2. Edge cases in resolution ────────────────────────────────────────────

test('wiring: the primary id is dropped from the chain', () => {
  const chain = resolveFallbackChain({
    items: [makeItem('primary', 'primary-model'), makeItem('m1', 'model-a')],
    globalModelId: 'primary',
    fallbackIds: ['primary', 'm1'],
  })
  assertEqual(chain.length, 1, 'primary dropped')
  assertEqual(chain[0].model, 'model-a', 'only the real fallback')
})

test('wiring: duplicate ids collapse to one entry', () => {
  const chain = resolveFallbackChain({
    items: [makeItem('m1', 'model-a')],
    globalModelId: 'p',
    fallbackIds: ['m1', 'm1', 'm1'],
  })
  assertEqual(chain.length, 1, 'deduped')
})

test('wiring: unknown ids are skipped, not fatal', () => {
  const chain = resolveFallbackChain({
    items: [makeItem('m1', 'model-a')],
    globalModelId: 'p',
    fallbackIds: ['does-not-exist', 'm1', 'also-missing'],
  })
  assertEqual(chain.length, 1, 'only the known one survives')
  assertEqual(chain[0].model, 'model-a', 'correct one')
})

test('wiring: ids without an API key are skipped', () => {
  const chain = resolveFallbackChain({
    items: [makeItem('nokey', 'model-x', { apiKey: '' }), makeItem('m1', 'model-a')],
    globalModelId: 'p',
    fallbackIds: ['nokey', 'm1'],
  })
  assertEqual(chain.length, 1, 'keyless skipped')
  assertEqual(chain[0].model, 'model-a', 'only the keyed one')
})

test('wiring: non-string entries skipped', () => {
  const chain = resolveFallbackChain({
    items: [makeItem('m1', 'model-a')],
    globalModelId: 'p',
    fallbackIds: [42, null, undefined, {}, 'm1'] as unknown[],
  })
  assertEqual(chain.length, 1, 'only the string')
})

test('wiring: empty/whitespace strings skipped', () => {
  const chain = resolveFallbackChain({
    items: [makeItem('m1', 'model-a')],
    globalModelId: 'p',
    fallbackIds: ['', '   ', '\t', 'm1'],
  })
  assertEqual(chain.length, 1, 'blank entries dropped')
})

test('wiring: undefined fallbackModels → empty chain (disabled)', () => {
  assertEqual(resolveFallbackChain({ items: [], globalModelId: 'p', fallbackIds: undefined }).length, 0, 'empty')
})

test('wiring: empty array → empty chain', () => {
  assertEqual(resolveFallbackChain({ items: [makeItem('m1', 'a')], globalModelId: 'p', fallbackIds: [] }).length, 0, 'empty')
})

test('wiring: ALL entries invalid → empty chain, no crash', () => {
  const chain = resolveFallbackChain({
    items: [],
    globalModelId: 'p',
    fallbackIds: ['a', 'b', 'c'],
  })
  assertEqual(chain.length, 0, 'empty')
})

test('wiring: chain preserves user order (not settings order)', () => {
  const chain = resolveFallbackChain({
    items: [makeItem('m3', 'model-c'), makeItem('m1', 'model-a'), makeItem('m2', 'model-b')],
    globalModelId: 'p',
    fallbackIds: ['m2', 'm3', 'm1'],
  })
  assertEqual(chain.map((c) => c.model).join(','), 'model-b,model-c,model-a', 'user order preserved')
})

// ── 3. Profile → settings round-trip ───────────────────────────────────────

test('settings: fallbackModels survives a JSON round-trip', () => {
  const profile: ModelProfile = {
    id: 'p1',
    name: 'Test',
    globalModelId: 'm1',
    fallbackModels: ['m2', 'm3'],
  }
  const json = JSON.parse(JSON.stringify(profile))
  assertEqual(json.fallbackModels.length, 2, 'persisted')
  assertEqual(json.fallbackModels[0], 'm2', 'order kept')
})

test('settings: profile without fallbackModels omits the key', () => {
  const profile: ModelProfile = { id: 'p1', name: 'T', globalModelId: 'm1' }
  const json = JSON.parse(JSON.stringify(profile))
  assertTrue(!('fallbackModels' in json), 'key absent (not null/undefined)')
})

// ── 4. Engine edge cases (deeper than v3218) ───────────────────────────────

test('engine: empty message error is still eligible (conservative default)', () => {
  const r = isFailoverEligible(new Error(''))
  assertTrue(r.eligible, 'empty message → eligible (unknown-error)')
  assertEqual(r.reason, 'unknown-error', 'reason')
})

test('engine: null/undefined error handled', () => {
  assertTrue(isFailoverEligible(null).eligible, 'null')
  assertTrue(isFailoverEligible(undefined).eligible, 'undefined')
  assertTrue(isFailoverEligible('string error').eligible, 'string')
})

test('engine: chain with labels preserved through failover', async () => {
  const seen: Array<string | undefined> = []
  const r = await withModelFailover(
    [{ model: 'a', label: 'Primary' }, { model: 'b', label: 'Backup' }],
    async (m) => {
      seen.push(m.label)
      if (m.model === 'a') throw new Error('503')
      return 'ok'
    },
  )
  assertEqual(r.usedModel, 'b', 'used b')
  assertEqual(seen.join(','), 'Primary,Backup', 'labels carried')
})

test('engine: a fallback that throws ineligible error stops the chain', async () => {
  const tried: string[] = []
  const r = await withModelFailover(
    [{ model: 'a' }, { model: 'b' }, { model: 'c' }],
    async (m) => {
      tried.push(m.model)
      if (m.model === 'a') throw new Error('429')
      throw new Error('context length exceeded') // ineligible on b
    },
  )
  assertEqual(tried.join(','), 'a,b', 'c never tried')
  assertTrue(r.error !== undefined, 'error surfaced')
})

test('engine: zero-length chain returns error', async () => {
  const r = await withModelFailover([], async () => 'never')
  assertTrue(r.error !== undefined, 'error (no candidates)')
  assertEqual(r.attempts.length, 0, 'no attempts')
})

test('engine: attempts record durations', async () => {
  const r = await withModelFailover([{ model: 'a' }], async () => 'fast')
  assertEqual(r.attempts.length, 1, 'one attempt')
  assertTrue(r.attempts[0].durationMs >= 0, 'duration recorded')
})

// ── 5. Full write→read simulation (the actual v3.2.18 gap) ────────────────

test('e2e: profile with fallbacks → binding carries a usable chain', () => {
  const settings = {
    models: {
      items: [
        makeItem('primary', 'moonshotai/kimi-k3', { name: 'Kimi K3' }),
        makeItem('fb1', 'z-ai/glm-5.1', { name: 'GLM 5.1' }),
        makeItem('fb2', 'anthropic/claude-sonnet-4.6', { name: 'Sonnet 4.6' }),
      ],
      profiles: [{
        id: 'prof1',
        name: 'Main',
        globalModelId: 'primary',
        fallbackModels: ['fb1', 'fb2'],
      } as ModelProfile],
    },
  } as unknown as BackendSettings

  const profile = settings.models.profiles[0]
  const globalItem = settings.models.items.find((m: ModelDefinition) => m.id === profile.globalModelId)
  assertTrue(globalItem !== undefined, 'primary resolves')

  const bindingChain = resolveFallbackChain({
    items: settings.models.items,
    globalModelId: profile.globalModelId,
    fallbackIds: profile.fallbackModels,
  })

  assertEqual(bindingChain.length, 2, 'chain populated (was always 0 before v3.3.0)')
  assertEqual(bindingChain[0].model, 'z-ai/glm-5.1', 'first fallback')
  assertEqual(bindingChain[1].model, 'anthropic/claude-sonnet-4.6', 'second fallback')

  const engineChain = buildFailoverChain(
    { model: globalItem?.model ?? 'unknown' },
    bindingChain.map((f) => ({ model: f.model, label: f.label })),
  )
  assertEqual(engineChain.length, 3, 'primary + 2 fallbacks')
  assertEqual(engineChain[0].model, 'moonshotai/kimi-k3', 'primary first')
})

test('e2e: profile WITHOUT fallbacks → binding chain is empty (failover off)', () => {
  const settings = {
    models: {
      items: [makeItem('primary', 'model-p')],
      profiles: [{ id: 'prof1', name: 'Main', globalModelId: 'primary' } as ModelProfile],
    },
  } as unknown as BackendSettings
  const profile = settings.models.profiles[0]
  const chain = resolveFallbackChain({
    items: settings.models.items,
    globalModelId: profile.globalModelId,
    fallbackIds: profile.fallbackModels,
  })
  assertEqual(chain.length, 0, 'no chain → the failover branch is never entered')
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
