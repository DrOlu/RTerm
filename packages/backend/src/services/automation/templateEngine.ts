/**
 * Minimal Jinja-subset template renderer (no external dependency).
 *
 * Supports the constructs used by typical network-config templates:
 *   - {{ expression }}             variable interpolation with filters
 *   - {{ var | default('x') }}     filters: default, upper, lower, length
 *   - {% for item in list %}…{% endfor %}   iterate arrays/strings
 *   - {% if cond %}…{% elif %}…{% else %}…{% endif %}   conditionals
 *   - {% for k, v in object.items() %}      iterate object key/value
 *
 * Deliberately small and safe: it renders from a variables map only (no
 * arbitrary code execution). It is NOT a full Jinja2 implementation — just
 * enough for parameterized config templates. Fully unit-testable.
 */

export type TemplateVars = Record<string, unknown>

type Token = { type: 'text' | 'tag' | 'expr'; value: string }

/** A tiny value resolver: supports dotted paths (a.b.c). */
function resolve(expr: string, scope: TemplateVars): unknown {
  const parts = expr.trim().split('.')
  let cur: unknown = scope
  for (const p of parts) {
    if (cur == null) return undefined
    if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return undefined
    }
  }
  return cur
}

function applyFilters(value: unknown, filters: string[], scope: TemplateVars): unknown {
  let v = value
  for (const f of filters) {
    const m = f.match(/^(\w+)\s*(?:\((.*)\))?$/)
    if (!m) continue
    const name = m[1]
    const argRaw = m[2] ?? ''
    const arg = argRaw.replace(/^['"]|['"]$/g, '')
    switch (name) {
      case 'default':
        if (v === undefined || v === null || v === '') {
          v = arg in scope ? resolve(arg, scope) : arg
        }
        break
      case 'upper': v = String(v ?? '').toUpperCase(); break
      case 'lower': v = String(v ?? '').toLowerCase(); break
      case 'length':
        if (Array.isArray(v)) v = v.length
        else if (typeof v === 'string') v = v.length
        else v = 0
        break
      default:
        break
    }
  }
  return v
}

/** Evaluate a {{ }} expression (value + optional filters). */
function evalExpr(expr: string, scope: TemplateVars): string {
  const parts = expr.split('|').map((p) => p.trim())
  const varExpr = parts[0]
  const filters = parts.slice(1)
  let val = resolve(varExpr, scope)
  val = applyFilters(val, filters, scope)
  if (val === undefined || val === null) return ''
  if (Array.isArray(val)) return val.join(', ')
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

/** Evaluate a condition expression for {% if %}. Supports ==, !=, truthiness. */
function evalCond(expr: string, scope: TemplateVars): boolean {
  const e = expr.trim()
  const eq = e.match(/^(.+?)\s*(==|!=)\s*(.+)$/)
  if (eq) {
    const left = resolve(eq[1].trim(), scope)
    let rightRaw = eq[3].trim()
    let right: unknown
    if (/^['"].*['"]$/.test(rightRaw)) right = rightRaw.replace(/^['"]|['"]$/g, '')
    else if (/^-?\d+$/.test(rightRaw)) right = parseInt(rightRaw, 10)
    else right = resolve(rightRaw, scope)
    if (eq[2] === '==') return left == right
    return left != right
  }
  const v = resolve(e, scope)
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'string') return v.length > 0
  return Boolean(v)
}

/** Strip {% %} tag trim markers (- ... -). */
function cleanTag(inner: string): string {
  return inner.replace(/^-|\s-$/g, '').trim()
}

function tokenize(tpl: string): Token[] {
  const tokenRe = /(\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\})/g
  let lastIndex = 0
  const tokens: Token[] = []
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(tpl)) !== null) {
    if (m.index > lastIndex) tokens.push({ type: 'text', value: tpl.slice(lastIndex, m.index) })
    const tok = m[0]
    if (tok.startsWith('{%')) tokens.push({ type: 'tag', value: cleanTag(tok.slice(2, -2)) })
    else tokens.push({ type: 'expr', value: tok.slice(2, -2).trim() })
    lastIndex = m.index + tok.length
  }
  if (lastIndex < tpl.length) tokens.push({ type: 'text', value: tpl.slice(lastIndex) })
  return tokens
}

function findMatchingEnd(toks: Token[], start: number, open: string, close: string): number {
  let depth = 1
  for (let j = start + 1; j < toks.length; j++) {
    if (toks[j].type !== 'tag') continue
    const f = toks[j].value.split(/\s+/)[0]
    if (f === open) depth++
    else if (f === close) { depth--; if (depth === 0) return j }
  }
  throw new Error(`Unbalanced {% ${open} %}: missing {% ${close} %}`)
}

function findMatchingEndIf(toks: Token[], start: number): number {
  let depth = 1
  for (let j = start + 1; j < toks.length; j++) {
    if (toks[j].type !== 'tag') continue
    const f = toks[j].value.split(/\s+/)[0]
    if (f === 'if') depth++
    else if (f === 'endif') { depth--; if (depth === 0) return j }
  }
  throw new Error('Unbalanced {% if %}: missing {% endif %}')
}

function splitIfElse(body: Token[]): {
  ifBody: Token[]
  elseBody: Token[]
  elifs: { cond: string; body: Token[] }[]
} {
  let ifBody: Token[] = []
  let elseBody: Token[] = []
  let elifs: { cond: string; body: Token[] }[] = []
  let cur = ifBody
  let curElif: { cond: string; body: Token[] } | null = null
  let depth = 0
  for (const t of body) {
    if (t.type === 'tag') {
      const f = t.value.split(/\s+/)[0]
      if (f === 'if') depth++
      if (f === 'endif') depth = Math.max(0, depth - 1)
      if (depth === 0 && f === 'elif') {
        const cond = t.value.replace(/^elif\s+/, '')
        curElif = { cond, body: [] }
        elifs.push(curElif)
        cur = curElif.body
        continue
      }
      if (depth === 0 && f === 'else') { cur = elseBody; continue }
    }
    cur.push(t)
  }
  return { ifBody, elseBody, elifs }
}

/**
 * Render a Jinja-subset template string against `vars`.
 * Throws on unbalanced block tags (for testability).
 */
export function renderTemplate(tpl: string, vars: TemplateVars = {}): string {
  const tokens = tokenize(tpl)

  function renderTokens(toks: Token[], scope: TemplateVars): string {
    let s = ''
    let idx = 0
    while (idx < toks.length) {
      const t = toks[idx]
      if (t.type === 'text') { s += t.value; idx++; continue }
      if (t.type === 'expr') { s += evalExpr(t.value, scope); idx++; continue }
      // tag
      const tag = t.value
      const first = tag.split(/\s+/)[0]
      if (first === 'for') {
        const fm = tag.match(/^for\s+(\w+)\s+in\s+(.+)$/)
        const fk = tag.match(/^for\s+(\w+)\s*,\s*(\w+)\s+in\s+(.+?)\.items\(\)$/)
        const bodyEnd = findMatchingEnd(toks, idx, 'for', 'endfor')
        const body = toks.slice(idx + 1, bodyEnd)
        idx = bodyEnd + 1
        if (fk) {
          const kName = fk[1]; const vName = fk[2]
          const obj = resolve(fk[3], scope) as Record<string, unknown> | undefined
          if (obj && typeof obj === 'object') {
            for (const [k, v] of Object.entries(obj)) {
              s += renderTokens(body, { ...scope, [kName]: k, [vName]: v })
            }
          }
        } else if (fm) {
          const name = fm[1]
          const list = resolve(fm[2], scope)
          if (Array.isArray(list)) {
            for (const item of list) s += renderTokens(body, { ...scope, [name]: item })
          } else if (typeof list === 'string') {
            for (const ch of list) s += renderTokens(body, { ...scope, [name]: ch })
          } else if (list && typeof list === 'object') {
            for (const [k, v] of Object.entries(list as object)) {
              s += renderTokens(body, { ...scope, [name]: { key: k, value: v } })
            }
          }
        }
        continue
      }
      if (first === 'if') {
        const cond = tag.replace(/^if\s+/, '')
        const bodyEnd = findMatchingEndIf(toks, idx)
        const { ifBody, elseBody, elifs } = splitIfElse(toks.slice(idx + 1, bodyEnd))
        idx = bodyEnd + 1
        let rendered = false
        if (evalCond(cond, scope)) { s += renderTokens(ifBody, scope); rendered = true }
        else {
          for (const e of elifs) {
            if (evalCond(e.cond, scope)) { s += renderTokens(e.body, scope); rendered = true; break }
          }
          if (!rendered && elseBody.length) s += renderTokens(elseBody, scope)
        }
        continue
      }
      // Unknown standalone tag: ignore.
      idx++
    }
    return s
  }

  return renderTokens(tokens, vars)
}

/** Produce a unified-style textual diff between two strings (line-based). */
export function diffStrings(a: string, b: string): string {
  const aLines = a.split('\n')
  const bLines = b.split('\n')
  const lines: string[] = []
  const max = Math.max(aLines.length, bLines.length)
  for (let i = 0; i < max; i++) {
    const al = aLines[i]
    const bl = bLines[i]
    if (al === bl) { if (al !== undefined) lines.push(`  ${al}`) }
    else {
      if (al !== undefined) lines.push(`- ${al}`)
      if (bl !== undefined) lines.push(`+ ${bl}`)
    }
  }
  return lines.join('\n')
}
