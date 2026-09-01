/**
 * kit.extreme.spec — the primitive-kit test suite (v3.6.0).
 * Pure render/variant logic via react-test-renderer-free DOM-less checks:
 * cva composes the right classes, cn merges, every variant maps to a class
 * that EXISTS in kit.scss, and the SCSS consumes only semantic tokens.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as url from 'node:url'
import {
  cn, buttonVariants, badgeVariants, cardVariants, dotVariants, inputVariants,
} from './index'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

const cases: Array<{ name: string; run: () => void }> = []
function test(name: string, run: () => void) { cases.push({ name, run }) }
function assertTrue(cond: boolean, msg: string) { if (!cond) throw new Error(msg) }
function assertEqual<T>(a: T, b: T, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}. expected=${JSON.stringify(b)} actual=${JSON.stringify(a)}`)
}

// ---- cn ----
test('cn: merges classes and handles conditionals', () => {
  assertEqual(cn('a', 'b'), 'a b', 'plain merge')
  assertEqual(cn('a', undefined, false && 'x', 'b'), 'a b', 'falsy skipped')
  assertEqual(cn({ c: true, d: false }), 'c', 'object form')
})

// ---- every cva class exists in kit.scss (no dead classes) ----
const KIT_SCSS = fs.readFileSync(
  path.join(__dirname, '../../styles/components/kit.scss'), 'utf-8')

test('buttonVariants: every emitted class is defined in kit.scss', () => {
  for (const variant of ['primary','secondary','outline','ghost','danger','link'] as const) {
    for (const size of ['xs','sm','md','lg','icon','icon-lg'] as const) {
      const cls = buttonVariants({ variant, size })
      for (const c of cls.split(' ')) {
        assertTrue(
          KIT_SCSS.includes(`.${c} `) || KIT_SCSS.includes(`.${c}{`) ||
          KIT_SCSS.includes(`.${c}:`) || KIT_SCSS.includes(`.${c} `),
          `class .${c} (variant=${variant} size=${size}) missing from kit.scss`)
      }
    }
  }
})

test('badgeVariants: every class defined', () => {
  for (const v of ['neutral','primary','success','warning','danger','outline'] as const) {
    const cls = badgeVariants({ variant: v })
    assertTrue(KIT_SCSS.includes(`.${cls.split(' ')[1]}`), `.${cls} missing`)
  }
})

test('cardVariants: raised/glow classes defined', () => {
  assertTrue(KIT_SCSS.includes('.kit-card--raised'), 'raised defined')
  assertTrue(KIT_SCSS.includes('.kit-card--glow'), 'glow defined')
  const c = cardVariants({ raised: true, glow: true })
  assertTrue(c.includes('kit-card--raised') && c.includes('kit-card--glow'), 'both compose')
})

test('dotVariants: every status class defined', () => {
  for (const s of ['success','warning','danger','neutral'] as const) {
    const cls = dotVariants({ status: s })
    assertTrue(KIT_SCSS.includes(`.${cls.split(' ')[1]}`), `.${cls} missing`)
  }
  assertTrue(dotVariants({ pulse: true }).includes('kit-dot--pulse'), 'pulse composes')
})

test('inputVariants: invalid composes', () => {
  assertTrue(inputVariants({ invalid: true }).includes('kit-input--invalid'), 'invalid class')
  assertTrue(!inputVariants({}).includes('kit-input--invalid'), 'default has no invalid')
})

// ---- defaults ----
test('defaults: button secondary/md, badge neutral', () => {
  const b = buttonVariants({})
  assertTrue(b.includes('kit-button--secondary') && b.includes('kit-button--md'), 'button defaults')
  assertTrue(badgeVariants({}).includes('kit-badge--neutral'), 'badge default')
})

// ---- the SCSS token discipline: kit.scss consumes ONLY semantic tokens ----
test('kit.scss: consumes only semantic tokens (no legacy names, no raw colors)', () => {
  // check RULES against the comment-stripped source (comments may document
  // the legacy names; only actual usage violates the discipline)
  const noComments = KIT_SCSS.replace(/\/\*[\s\S]*?\*\//g, '')
  // check for legacy USAGE (var(--x) / value refs), not substrings —
  // '--color-danger:' legitimately contains '--danger:' but is semantic.
  for (const legacy of ['app-bg', 'panel-bg', 'accent-2', 'fg-muted', 'control-bg', 'font-ui']) {
    assertTrue(!new RegExp(`var\\(--${legacy}\\)|: var\\(--${legacy}`).test(noComments),
      `kit.scss must not USE legacy token --${legacy}`)
  }
  // the bare legacy status tokens (--danger/--success/--warning) are only
  // a violation when referenced directly, not as part of --color-danger
  for (const bare of ['danger', 'success', 'warning', 'accent', 'fg']) {
    const re = new RegExp(`var\\(--${bare}\\)|var\\(--${bare}-rgb\\)`)
    assertTrue(!re.test(noComments), `kit.scss must not USE legacy token --${bare}`)
  }
  // no bare #hex outside comments
  const hexes = noComments.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
  assertEqual(hexes, [], `kit.scss must have no raw hex (found ${hexes})`)
})

// ---- tokens.scss: defines the full semantic set ----
const TOKENS_SCSS = fs.readFileSync(
  path.join(__dirname, '../../styles/tokens.scss'), 'utf-8')

test('tokens.scss: the semantic scale is complete', () => {
  for (const t of ['--color-bg','--color-surface','--color-fg','--color-fg-muted',
    '--color-border','--color-primary','--color-primary-rgb','--color-danger',
    '--color-success','--color-warning','--color-ring','--space-1','--space-4',
    '--radius-sm','--radius-md','--radius-full','--text-sm','--shadow-md',
    '--ease-out','--dur-fast','--z-modal']) {
    assertTrue(TOKENS_SCSS.includes(`${t}:`), `token ${t} defined`)
  }
})

test('tokens.scss: the semantic layer is structurally sound (v3.7.1 re-theme)', () => {
  // v3.7.1 re-themed the DEFAULT palette (neutral graphite dark — the
  // 'rterm-dark' mode in appTheme.ts) and added runtime theme switching
  // that sets the SEMANTIC layer directly. The alias-the-legacy-palette
  // assertion was correct for v3.6.0 but froze hex values; the design
  // contract is now STRUCTURAL, not value-based:
  //   1. every semantic color resolves to a primitive (no raw hex inline)
  //   2. the default dark is actually dark (the re-theme's point: dark is DARK)
  //   3. the appTheme runtime sets the semantic names (theme switching works)
  // the on-* pairs (text on brand fills) are legitimately direct values;
  // every OTHER semantic color must alias a primitive
  const semLine = /^\s*--color-(?!on-)[a-z0-9-]+: (var\(--p-[a-z0-9-]+\)|#[0-9a-fA-F]{3,8})/gm
  let m: RegExpExecArray | null, rawHex = 0, aliased = 0
  while ((m = semLine.exec(TOKENS_SCSS)) !== null) {
    if (m[1].startsWith('#')) rawHex++
    else aliased++
  }
  assertTrue(aliased > 10, `semantic colors alias primitives (${aliased} aliased)`)
  assertTrue(rawHex === 0, `no raw hex in the semantic color layer (found ${rawHex})`)
  // dark is dark: the bg primitive must be a near-black luminance
  const bg = TOKENS_SCSS.match(/--p-ink-900: (#[0-9a-fA-F]{6})/)
  if (bg) {
    const n = Number.parseInt(bg[1].slice(1), 16)
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    assertTrue(lum < 0.08, `the default bg is genuinely dark (luminance ${lum.toFixed(3)} < 0.08)`)
  }
})

// ---- runner ----
let pass = 0, fail = 0
for (const c of cases) {
  try { c.run(); pass++; console.log(`PASS ${c.name}`) }
  catch (e: any) { fail++; console.log(`FAIL ${c.name}: ${e?.message ?? e}`) }
}
console.log(`\n${pass}/${cases.length} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
console.log('kit: ALL TESTS PASSED')
