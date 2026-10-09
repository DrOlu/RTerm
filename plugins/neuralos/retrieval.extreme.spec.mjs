/**
 * retrieval — extreme spec for the neuralos plugin's top-K probe retrieval
 * (v3.9.8, the productized ask.py contract).
 *
 * Pure invariants, no engine, no network:
 *   - the ask.py scoring weights (triggers x3, name x1, description x0.3)
 *   - top-K selection with stable ties and a >0 score floor
 *   - the threshold rule: small menus return null (full menu to the engine)
 *   - the never-hide rule: a question matching NOTHING returns null
 *   - the enum fast path: all-required-args-enum-caged + verbatim values
 *     fires deterministically; anything else returns null (engine path)
 *   - filtered-menu file round-trip (writeRetrievedMenu / cleanup)
 *
 * Run:  npx tsx plugins/neuralos/retrieval.extreme.spec.mjs
 */
import assert from 'node:assert'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  RETRIEVAL_TOP_K,
  RETRIEVAL_MENU_THRESHOLD,
  tokenize,
  scoreProbe,
  retrieveProbes,
  enumFastPath,
  writeRetrievedMenu,
  cleanupRetrievedMenu,
} from './retrieval.mjs'

let pass = 0
let fail = 0
const failures = []

function ok(cond, label, note = '') {
  if (cond) {
    pass++
    console.log(`PASS ${label}`)
  } else {
    fail++
    failures.push(`${label}${note ? ` — ${note}` : ''}`)
    console.log(`FAIL ${label}${note ? ` — ${note}` : ''}`)
  }
}

const probe = (name, triggers = [], description = '', parameters) => ({
  name,
  ...(triggers.length ? { triggers } : {}),
  ...(description ? { description } : {}),
  ...(parameters ? { parameters } : {}),
})

// ---------------------------------------------------------------------------
// 1. Tokenizer: stopwords dropped, underscores kept, case-insensitive.
//    NOTE: `list` IS in the ask.py stop list (so is `show`, `me`, `all`) —
//    these are command-verbs that appear in almost every probe trigger and
//    carry no discriminating weight. That is faithful to ask.py.
{
  const t = tokenize('The Top-Customers of Chinook_Invoices!')
  ok(!t.has('the') && !t.has('of'), 'stopwords are dropped')
  ok(t.has('top') && t.has('customers'), 'hyphenated words split into plain tokens')
  ok(t.has('chinook_invoices'), 'underscores stay part of the token')
  ok(!tokenize('list all customers').has('list') && !tokenize('list all customers').has('all'), 'command verbs (list/all) are stopwords')
  ok(tokenize('').size === 0 && tokenize(null).size === 0, 'empty/null is an empty set')
}

// ---------------------------------------------------------------------------
// 2. Scoring weights: trigger (3) > name (1) > description (0.3).
//    'customers by country': customers + country are non-stop tokens.
{
  const q = tokenize('customers by country')
  const trigOnly = probe('p1', ['customers by country'])
  const nameOnly = probe('customers_by_country')
  const descOnly = probe('p3', [], 'customers by country ranked')
  const st = scoreProbe(trigOnly, q)
  const sn = scoreProbe(nameOnly, q)
  const sd = scoreProbe(descOnly, q)
  ok(st === 6, `trigger overlap scores 3/token (2 tokens = 6), got ${st}`)
  ok(sn === 2, `name overlap scores 1/token (2 tokens = 2), got ${sn}`)
  ok(Math.abs(sd - 0.6) < 1e-9, `description scores 0.3/token (2 tokens = 0.6), got ${sd}`)
  ok(st > sn && sn > sd, 'trigger > name > description ordering holds')
}

// ---------------------------------------------------------------------------
// 3. retrieveProbes: top-K, threshold, never-hide.
{
  const menu = Array.from({ length: 20 }, (_, i) => probe(`filler_${i}`, [`filler ${i} thing`]))
  menu.push(probe('invoices_count', ['how many invoices', 'count invoices'], 'invoice total count'))
  menu.push(probe('invoices_recent', ['recent invoices', 'latest invoices'], 'latest invoice rows'))

  const r = retrieveProbes(menu, 'count invoices', { menuThreshold: 13, topK: 8 })
  ok(Array.isArray(r) && r.length > 0, 'a matching question retrieves probes')
  ok(r[0].name === 'invoices_count', `rank-1 is the best match, got ${r[0]?.name}`)
  ok(r.length <= RETRIEVAL_TOP_K, `never more than top-K (${RETRIEVAL_TOP_K})`)

  const small = [probe('invoices_count', ['count invoices'])]
  ok(retrieveProbes(small, 'count invoices') === null, `menus below the threshold (${RETRIEVAL_MENU_THRESHOLD}) return null — the engine gets the full menu`)

  ok(retrieveProbes(menu, 'xyzzy qwerwerty', { menuThreshold: 13 }) === null, 'a question matching NOTHING returns null (never-hide rule)')

  const manyMatching = menu.concat(Array.from({ length: 10 }, (_, i) => probe(`inv_${i}`, ['invoice'])))
  const r2 = retrieveProbes(manyMatching, 'invoice', { menuThreshold: 13, topK: 5 })
  ok(r2.length === 5, 'top-K caps the result (5 requested, 5 returned)')

  ok(retrieveProbes('not an array', 'invoice') === null, 'a non-array menu returns null')
  ok(retrieveProbes(menu, '   ', { menuThreshold: 13 }) === null, 'a whitespace-only question returns null')
}

// ---------------------------------------------------------------------------
// 4. The enum fast path: deterministic firing rules.
{
  const mailCount = probe('mail_count', ['count messages'], 'count for one folder', {
    type: 'object',
    properties: { folder: { type: 'string', enum: ['inbox', 'sentitems', 'drafts'] } },
    required: ['folder'],
  })

  const hit = enumFastPath(mailCount, 'how many messages in sentitems')
  ok(hit?.pick === 'mail_count' && hit.args.folder === 'sentitems', 'all-required-enum present verbatim -> fires with the matched value')
  ok(hit?.fastPath === true, 'the fast-path result is flagged')

  const missing = enumFastPath(mailCount, 'how many messages are there')
  ok(missing === null, 'required enum value NOT in the question -> null (engine path)')

  const caseHit = enumFastPath(mailCount, 'show me SENTITEMS totals')
  ok(caseHit?.args.folder === 'sentitems', 'matching is case-insensitive')

  const uncaged = probe('mail_search', ['search mail'], 'search', {
    type: 'object',
    properties: { folder: { type: 'string', enum: ['inbox'] }, query: { type: 'string' } },
    required: ['folder', 'query'],
  })
  ok(enumFastPath(uncaged, 'search inbox for hello') === null, 'a required NON-enum arg -> null (the engine must ground it)')

  const optionalEnum = probe('mail_latest', ['latest email'], 'latest', {
    type: 'object',
    properties: { folder: { type: 'string', enum: ['inbox', 'sentitems'] } },
    required: [],
  })
  ok(enumFastPath(optionalEnum, 'latest email in sentitems')?.args.folder === 'sentitems', 'optional enum args fill when present')
  ok(enumFastPath(optionalEnum, 'latest email') === null, 'an all-optional probe never fast-paths (nothing required to verify)')
}

// ---------------------------------------------------------------------------
// 5. Filtered-menu file round trip + cleanup.
{
  const dir = mkdtempSync(join(tmpdir(), 'neuralos-retrieval-'))
  try {
    const retrieved = [probe('a_probe', ['a']), probe('b_probe', ['b'])]
    const p = await writeRetrievedMenu(dir, retrieved)
    ok(existsSync(p), 'the filtered menu file is materialized (the engine needs a real --tools file)')
    ok(JSON.parse(readFileSync(p, 'utf-8')).length === 2, 'the file holds exactly the retrieved probes')
    await cleanupRetrievedMenu(p)
    ok(!existsSync(p), 'cleanup removes the filtered menu file')
    await cleanupRetrievedMenu(null)
    ok(true, 'cleanup(null) is a safe no-op')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 6. Ranking sanity on a REAL-shaped menu (chinook-style).
{
  const menu = [
    probe('chinook_overview', ['overview', 'database summary'], 'database overview'),
    probe('chinook_top_customers', ['top customers', 'best customers'], 'customers ranked by spend'),
    probe('chinook_artist_top_customers', ['artist top customers'], 'top customers of one artist', {
      type: 'object',
      properties: { artist: { type: 'string' } },
      required: ['artist'],
    }),
    probe('chinook_sales_by_country', ['sales by country', 'revenue by country'], 'sales per country'),
    probe('chinook_invoice_detail', ['invoice detail'], 'one invoice', {
      type: 'object',
      properties: { invoice_id: { type: 'number' } },
      required: ['invoice_id'],
    }),
    probe('chinook_tracks_by_genre', ['tracks by genre'], 'tracks in a genre'),
  ]
  const r = retrieveProbes(menu, 'sales by country', { menuThreshold: 3, topK: 3 })
  ok(r[0].name === 'chinook_sales_by_country', `country question ranks sales_by_country first, got ${r[0]?.name}`)
  ok(r.every((p) => p.name !== 'chinook_invoice_detail'), 'the numeric-id detail probe is not ranked for a country question')

  // the fast path must NOT fire for it (invoice_id/artist are required non-enum;
  // sales_by_country has no required args) — the engine stays in the loop.
  ok(enumFastPath(r[0], 'sales by country') === null, 'probes with no enum args never fast-path — the engine decides')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log(`FAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  process.exit(1)
}
console.log('retrieval: ALL TESTS PASSED')
