/**
 * retrieval — the structured retrieval front-end for the neuralos plugin
 * (v3.9.8), a faithful port of the instances' ask.py contract, merged with
 * the enum fast-path proven live in this session.
 *
 * Why: the 121M engine selects less accurately as menus grow (the outlook-
 * mail instance misfired mail_forward on a "read latest mail" phrasing
 * with the full menu in context; the 37–60 probe instances dilute it
 * further), and possessive phrasings never ground. So `neuralos_ask`:
 *
 *   1. scores every probe lexically (ask.py weights: triggers ×3,
 *      name ×1, description ×0.3), keeping only probes that score > 0,
 *   2. hands the engine ONLY the top-K most relevant probes (a filtered
 *      menu file, so `--tools` stays a real file),
 *   3. offers a deterministic fast path for enum-caged probes
 *      (`enumFastPath`): when the rank-1 probe's required arguments are
 *      all enum-caged AND each value appears verbatim in the question,
 *      the caller may skip the engine entirely,
 *   4. falls back to the FULL menu when nothing scores > 0 — a question
 *      that matches nothing must reach the engine, not dead-end. (This is
 *      the one failure mode ask.py had and this port fixes: retrieval can
 *      only focus, never hide.)
 *
 * Everything is pure except writeRetrievedMenu/cleanupRetrievedMenu (file
 * IO for the engine's --tools argument), so the contract is unit-testable
 * without a network or the engine binary.
 */

/** Default number of probes handed to the engine (the ask.py default). */
export const RETRIEVAL_TOP_K = 8

/**
 * Menus below this size go to the engine whole — its own selection is best
 * on small menus, and filtering a 10-probe menu saves nothing.
 */
export const RETRIEVAL_MENU_THRESHOLD = 13

/** Stopwords dropped before scoring — the ask.py stop list. */
const STOP = new Set(
  ('the a an of in on for to and or is are was were what which who how ' +
    'many show me give list all with their from by at it its do does did ' +
    'i we you this that those these there have has had more than one not ' +
    'use between during along per into over under about').split(' '),
)

/** Lowercase word tokens; underscores belong to tokens (probe names). */
export function tokenize(text) {
  const out = new Set()
  for (const t of String(text ?? '').toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    if (!STOP.has(t)) out.add(t)
  }
  return out
}

function overlap(a, b) {
  let n = 0
  for (const t of a) if (b.has(t)) n += 1
  return n
}

/** The ask.py weights: a trigger hit is worth 3× a name hit, ~10× a description hit. */
export function scoreProbe(probe, qTokens) {
  let score = 0
  for (const trig of probe?.triggers ?? []) {
    score += 3 * overlap(qTokens, tokenize(trig))
  }
  score += 1 * overlap(qTokens, tokenize(String(probe?.name ?? '').replace(/_/g, ' ')))
  score += 0.3 * overlap(qTokens, tokenize(probe?.description ?? ''))
  return score
}

/**
 * Score the whole menu and return the top-K probes with score > 0, best
 * first (ties keep menu order — stable). Returns `null` when retrieval
 * should be skipped so the caller falls back to the full menu:
 *   - the menu is below the threshold (small menus select best whole),
 *   - the menu is not an array,
 *   - the question has no tokens, or
 *   - no probe scored > 0 (the question shares no vocabulary with the menu).
 */
export function retrieveProbes(menu, question, opts = {}) {
  const topK = Number(opts.topK) > 0 ? Number(opts.topK) : RETRIEVAL_TOP_K
  const menuThreshold =
    Number(opts.menuThreshold) > 0 ? Number(opts.menuThreshold) : RETRIEVAL_MENU_THRESHOLD
  if (!Array.isArray(menu) || menu.length < menuThreshold) return null
  const qTokens = tokenize(question)
  if (qTokens.size === 0) return null
  const scored = []
  menu.forEach((probe, menuIndex) => {
    if (!probe || typeof probe.name !== 'string') return
    const score = scoreProbe(probe, qTokens)
    if (score > 0) scored.push({ probe, score, menuIndex })
  })
  if (scored.length === 0) return null
  scored.sort((a, b) => b.score - a.score || a.menuIndex - b.menuIndex)
  return scored.slice(0, topK).map((s) => s.probe)
}

/**
 * The deterministic fast path (the ask.py rule): fire when the probe's
 * REQUIRED arguments are all enum-caged AND every required value appears
 * verbatim (case-insensitive) in the question. Optional enum args are
 * filled when present. Returns null when the probe must go through the
 * engine (any required arg not enum-caged, any required enum value
 * missing from the question, or no enum arg matched at all).
 */
export function enumFastPath(probe, question) {
  const params = probe?.parameters?.properties ?? {}
  const required = Array.isArray(probe?.parameters?.required) ? probe.parameters.required : []
  const q = String(question ?? '').toLowerCase()
  const args = {}
  for (const [name, schema] of Object.entries(params)) {
    if (!Array.isArray(schema?.enum) || schema.enum.length === 0) continue
    const hit = schema.enum.find((v) => typeof v === 'string' && q.includes(v.toLowerCase()))
    if (hit !== undefined) args[name] = hit
  }
  for (const name of required) {
    const schema = params[name]
    if (!schema || !Array.isArray(schema.enum) || schema.enum.length === 0) return null
    if (!(name in args)) return null
  }
  if (Object.keys(args).length === 0) return null
  return { pick: probe.name, args, confidence: null, fastPath: true }
}

/**
 * Materialize the filtered menu (top-K probe entries, same schema as
 * needle_menu.json) as a sibling file of the instance menu and return its
 * path. The engine reads its menu from a FILE (--tools), so the filtered
 * menu must be a real file; a sibling in the instance dir keeps any
 * relative tool-index lookups working. `fsModule` is injectable for specs.
 */
export async function writeRetrievedMenu(instanceDir, retrievedMenu, fsModule) {
  const fsMod = fsModule ?? (await import('node:fs')).promises
  const path = await import('node:path')
  const menuPath = path.join(instanceDir, `.needle_menu.retrieved-${process.pid}.json`)
  await fsMod.writeFile(menuPath, JSON.stringify(retrievedMenu), 'utf-8')
  return menuPath
}

/** Remove a previously written retrieved-menu file (best effort). */
export async function cleanupRetrievedMenu(menuPath, fsModule) {
  if (!menuPath) return
  try {
    const fsMod = fsModule ?? (await import('node:fs')).promises
    await fsMod.rm(menuPath, { force: true })
  } catch {
    /* best effort cleanup */
  }
}
