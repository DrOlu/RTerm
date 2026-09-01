/**
 * appTheme.extreme.spec — the v3.7.1 theme-switching test suite.
 *
 * The newest feature (two modes, runtime switching, custom-scheme
 * derivation) shipped with NO spec. This covers it with a minimal DOM stub:
 *   - the builtin dark mode sets the semantic layer (the Phase 3 contract)
 *   - the builtin light mode flips correctly
 *   - a CUSTOM dark scheme is derived (shaded surfaces, own accents)
 *   - a CUSTOM light scheme is derived
 *   - the legacy names are set too (stragglers keep working)
 *   - the on-color pairs flip with mode
 *   - the ring follows the accent
 *   - an invalid accent hex degrades gracefully (no crash, ring falls back)
 */
// ---- minimal DOM stub (jsdom-free) ----
class StyleStub {
  props = new Map<string, string>()
  setProperty(k: string, v: string) { this.props.set(k, v) }
  removeProperty(k: string) { this.props.delete(k) }
}
const styleStub = new StyleStub()
const docStub = {
  documentElement: { style: styleStub },
} as unknown as Document

// @ts-ignore — inject before the module reads document
(globalThis as any).document = docStub

const { applyAppThemeFromTerminalScheme } = await import('./appTheme')
type Scheme = Parameters<typeof applyAppThemeFromTerminalScheme>[0]

const cases: Array<{ name: string; run: () => void }> = []
function test(name: string, run: () => void) { cases.push({ name, run }) }
function assertTrue(c: boolean, msg: string) { if (!c) throw new Error(msg) }

const mk = (over: Partial<Scheme> = {}): Scheme => ({
  name: 'test-scheme',
  background: '#0d0d0f',
  foreground: '#f2f2f4',
  colors: ['#f2f2f4', '#f87171', '#4ade80', '#facc15', '#60a5fa', '#c084fc'],
  ...over,
} as Scheme)

const get = (k: string) => styleStub.props.get(k)

// ---- 1. builtin dark ----
test('builtin dark: the semantic layer is set', () => {
  styleStub.props.clear()
  applyAppThemeFromTerminalScheme(mk())
  assertTrue(get('--color-bg') === '#0d0d0f', `bg: ${get('--color-bg')}`)
  assertTrue(get('--color-surface') === '#141417', `surface: ${get('--color-surface')}`)
  assertTrue(get('--color-fg') === '#f2f2f4', `fg: ${get('--color-fg')}`)
  assertTrue(get('--color-primary') === '#60a5fa', `primary: ${get('--color-primary')}`)
  assertTrue(get('--color-primary-rgb') === '96, 165, 250', `primary-rgb: ${get('--color-primary-rgb')}`)
  assertTrue(get('--color-on-primary') === '#0b0b0d', `on-primary dark: ${get('--color-on-primary')}`)
})

// ---- 2. builtin light ----
test('builtin light: flips to the paper palette', () => {
  styleStub.props.clear()
  applyAppThemeFromTerminalScheme(mk({ background: '#ffffff', foreground: '#1a1a1e' }))
  assertTrue(get('--color-bg') === '#ffffff', `bg: ${get('--color-bg')}`)
  assertTrue(get('--color-fg') === '#1a1a1e', `fg: ${get('--color-fg')}`)
  assertTrue(get('--color-on-primary') === '#ffffff', `on-primary light: ${get('--color-on-primary')}`)
  assertTrue(get('--color-ring-offset') === '#ffffff', `ring-offset light: ${get('--color-ring-offset')}`)
})

// ---- 3. custom dark derived ----
test('custom dark: surfaces derived by shading, own accent kept', () => {
  styleStub.props.clear()
  applyAppThemeFromTerminalScheme(mk({ background: '#1a1a2e', foreground: '#eeeeee',
    colors: ['#ee', '#f87171', '#4ade80', '#facc15', '#ff7700', '#c084fc'] }))
  assertTrue(get('--color-bg') === '#1a1a2e', `custom bg kept: ${get('--color-bg')}`)
  assertTrue(get('--color-surface') !== '#141417', `surface derived (not the builtin): ${get('--color-surface')}`)
  assertTrue(get('--color-primary') === '#ff7700', `custom accent: ${get('--color-primary')}`)
  assertTrue(get('--color-on-primary') === '#0b0b0d', `dark on-colors: ${get('--color-on-primary')}`)
})

// ---- 4. custom light derived ----
test('custom light: derived with light-mode shading', () => {
  styleStub.props.clear()
  applyAppThemeFromTerminalScheme(mk({ background: '#f5f0e8', foreground: '#222222',
    colors: ['#222', '#f87171', '#4ade80', '#facc15', '#0066cc', '#c084fc'] }))
  assertTrue(get('--color-bg') === '#f5f0e8', `custom light bg: ${get('--color-bg')}`)
  assertTrue(get('--color-on-primary') === '#ffffff', `light on-colors: ${get('--color-on-primary')}`)
})

// ---- 5. legacy names set ----
test('legacy names: set alongside the semantic layer (stragglers keep working)', () => {
  styleStub.props.clear()
  applyAppThemeFromTerminalScheme(mk())
  for (const legacy of ['--app-bg', '--panel-bg', '--fg', '--border', '--control-bg', '--accent', '--danger', '--success', '--warning', '--shadow']) {
    assertTrue(get(legacy) !== undefined, `legacy ${legacy} set`)
  }
})

// ---- 6. the ring follows the accent ----
test('the focus ring follows the accent color', () => {
  styleStub.props.clear()
  applyAppThemeFromTerminalScheme(mk({ colors: ['#ee', '#f87171', '#4ade80', '#facc15', '#112233', '#c084fc'] }))
  assertTrue(get('--color-ring') === 'rgba(17, 34, 51, 0.55)', `ring: ${get('--color-ring')}`)
})

// ---- 7. invalid accent degrades gracefully ----
test('an invalid accent hex degrades gracefully (no crash, fallback ring)', () => {
  styleStub.props.clear()
  let threw = false
  try {
    applyAppThemeFromTerminalScheme(mk({ colors: ['#ee', '#f87171', '#4ade80', '#facc15', 'not-a-hex', '#c084fc'] }))
  } catch { threw = true }
  assertTrue(!threw, 'no crash on invalid hex')
  assertTrue(get('--color-primary') === 'not-a-hex', `the raw value still set: ${get('--color-primary')}`)
  assertTrue(get('--color-ring') === 'rgba(96, 165, 250, 0.55)', `fallback ring: ${get('--color-ring')}`)
})

// ---- 8. the applied marker ----
test('the data-theme-applied marker is set (the UI can detect a theme)', () => {
  styleStub.props.clear()
  applyAppThemeFromTerminalScheme(mk({ name: 'my-scheme' }))
  assertTrue(get('data-theme-applied') === 'my-scheme', `marker: ${get('data-theme-applied')}`)
})

// ---- 9. status colors come from the scheme ----
test('status colors come from the scheme palette', () => {
  styleStub.props.clear()
  applyAppThemeFromTerminalScheme(mk({ colors: ['#ee', '#ff0000', '#00ff00', '#ffff00', '#60a5fa', '#c084fc'] }))
  assertTrue(get('--color-danger') === '#ff0000', `danger: ${get('--color-danger')}`)
  assertTrue(get('--color-success') === '#00ff00', `success: ${get('--color-success')}`)
  assertTrue(get('--color-warning') === '#ffff00', `warning: ${get('--color-warning')}`)
})

let pass = 0, fail = 0
for (const c of cases) {
  try { c.run(); pass++; console.log(`PASS ${c.name}`) }
  catch (e: any) { fail++; console.log(`FAIL ${c.name}: ${e?.message ?? e}`) }
}
console.log(`\n${pass}/${cases.length} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
console.log('appTheme: ALL TESTS PASSED')
