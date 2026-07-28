/**
 * wigoloClient.mjs — a minimal, dependency-free HTTP client for the wigolo web
 * intelligence daemon (`wigolo serve`, default http://127.0.0.1:3333).
 *
 * wigolo exposes one REST route per tool: POST /v1/{search,fetch,crawl,cache,
 * extract,find_similar,research,agent,diff,watch}, GET /health, GET /v1/tools.
 * This client is pure + injectable (a `fetchImpl` is passed in) so it is fully
 * unit-testable offline with a mocked fetch — no runtime network baked in.
 *
 * Auth: when the daemon is started with WIGOLO_API_TOKEN, every /v1 request
 * needs `Authorization: Bearer <token>` (/health stays open). The client sends
 * the header only when a token is provided.
 */

export const DEFAULT_BASE_URL = 'http://127.0.0.1:3333'

/** Build request headers (adds the bearer token only when set). */
export function buildHeaders(token) {
  const h = { 'content-type': 'application/json', accept: 'application/json' }
  if (token) h.authorization = `Bearer ${token}`
  return h
}

/** Join a base URL + path safely (single slash). */
export function joinUrl(base, path) {
  const b = String(base || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const p = String(path || '').startsWith('/') ? String(path) : `/${path}`
  return `${b}${p}`
}

async function parseBody(res) {
  const text = await res.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return text }
}

export class WigoloApiError extends Error {
  constructor(status, path, body) {
    super(`wigolo ${status} ${path}: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300)}`)
    this.status = status
    this.path = path
    this.body = body
  }
}

export class WigoloClient {
  /**
   * @param {{ baseUrl?: string, token?: string, fetchImpl: Function }} opts
   *   fetchImpl(url, {method, headers, body}) -> Promise<{ok,status,text:()=>Promise<string>}>
   */
  constructor(opts = {}) {
    if (typeof opts.fetchImpl !== 'function') throw new Error('WigoloClient needs a fetchImpl')
    this.baseUrl = opts.baseUrl || DEFAULT_BASE_URL
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl
  }

  async #post(path, payload) {
    const res = await this.fetchImpl(joinUrl(this.baseUrl, path), {
      method: 'POST',
      headers: buildHeaders(this.token),
      body: JSON.stringify(payload ?? {}),
    })
    const body = await parseBody(res)
    if (!res.ok) throw new WigoloApiError(res.status, path, body)
    return body
  }

  async #get(path) {
    const res = await this.fetchImpl(joinUrl(this.baseUrl, path), {
      method: 'GET',
      headers: buildHeaders(this.token),
    })
    const body = await parseBody(res)
    if (!res.ok) throw new WigoloApiError(res.status, path, body)
    return body
  }

  /** Liveness + component status. Always open (no token). */
  async health() {
    try {
      const body = await this.#get('/health')
      return { ok: true, status: body }
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  }

  /** List the daemon's tools (descriptions + endpoints). */
  async tools() {
    return this.#get('/v1/tools')
  }

  /** Multi-engine web search. `query` is a string or an array (parallel breadth). */
  async search(query, opts = {}) {
    return this.#post('/v1/search', { query, ...opts })
  }

  /** Fetch one URL as clean markdown (tiered router escalates to the browser engine). */
  async fetch(url, opts = {}) {
    return this.#post('/v1/fetch', { url, ...opts })
  }

  /** Multi-page crawl (BFS/DFS/sitemap/map-only). */
  async crawl(url, opts = {}) {
    return this.#post('/v1/crawl', { url, ...opts })
  }

  /** Structured extraction (tables, metadata, JSON-LD, named/custom schema). */
  async extract(url, opts = {}) {
    return this.#post('/v1/extract', { url, ...opts })
  }

  /** Pages similar to a URL/concept (keyword + semantic + live web fusion). */
  async findSimilar(input, opts = {}) {
    return this.#post('/v1/find_similar', typeof input === 'string' ? { url: input, ...opts } : { ...input, ...opts })
  }

  /** Query the local cache of everything already seen (keyword or hybrid semantic). */
  async cache(opts = {}) {
    return this.#post('/v1/cache', opts)
  }

  /** Decompose → fan out → fetch → return a structured brief + evidence.
   * (Synthesis is done by the HOST agent, not wigolo's LLM — we pass no LLM key,
   * so wigolo returns the raw brief + evidence and RTerm's agent writes the answer.) */
  async research(question, opts = {}) {
    return this.#post('/v1/research', { question, ...opts })
  }

  /** Autonomous gather loop (plan → search → fetch → extract) with a step log. */
  async agent(goal, opts = {}) {
    return this.#post('/v1/agent', { goal, ...opts })
  }

  /** Diff two page snapshots (or a page vs its last-seen cached version). */
  async diff(input, opts = {}) {
    return this.#post('/v1/diff', typeof input === 'string' ? { url: input, ...opts } : { ...input, ...opts })
  }

  /** Watch management: action=create|list|remove. */
  async watch(action, opts = {}) {
    return this.#post('/v1/watch', { action, ...opts })
  }
}
