/**
 * web-intel plugin — local-first web intelligence for RTerm's agent via wigolo.
 *
 * Gives the agent first-class web tools it doesn't have: multi-engine search,
 * clean-page fetch, site crawl, structured extract, similar-pages, cache,
 * research, and page-watch → RTerm trigger automation. All local-first, keyless
 * (search/fetch/crawl), and $0/query — the daemon runs on the same box.
 *
 * Synthesis uses RTerm's OWN agent, not a wigolo LLM — so there's NO LLM key to
 * manage. `web_research` asks wigolo for the decomposed evidence + citations and
 * RTerm's agent writes the cited answer from that brief.
 *
 * Lean by default: the daemon starts lazily with WIGOLO_NO_WARMUP=1 so the
 * ~1.5 GB browser engine + on-device models are NOT downloaded at init (search/
 * fetch/crawl work keyless without them). Set `warmupOnInit: true` to pre-fetch
 * them in the background.
 *
 * Config (Settings → webIntel block, resolved from ctx.settings / env):
 *   enabled       — master switch (default true)
 *   restUrl       — wigolo daemon base URL (default http://127.0.0.1:3333)
 *   token         — bearer token (optional; only if the daemon uses WIGOLO_API_TOKEN)
 *   autoStart     — start the daemon on first use (default true)
 *   warmupOnInit  — download the full browser engine + models in the background (default false = lean)
 *
 * The plugin never crashes RTerm when the daemon is down — every tool returns a
 * clear {error, hint} result instead of throwing (the agentspan-bridge pattern).
 */

import { WigoloClient, DEFAULT_BASE_URL } from './wigoloClient.mjs'
import { WigoloSidecar } from './sidecar.mjs'

// ─── config resolution ──────────────────────────────────────────────────────

/** Read the webIntel config block from RTerm settings (ctx.settings) or env. */
export function resolveConfig(ctx = {}, env = process.env) {
  const s = (typeof ctx.getSettings === 'function' ? ctx.getSettings() : ctx.settings) || {}
  const block = s.webIntel || {}
  return {
    enabled: block.enabled !== false,
    restUrl: String(block.restUrl || env.WIGOLO_REST_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, ''),
    token: block.token || env.WIGOLO_API_TOKEN || undefined,
    autoStart: block.autoStart !== false,
    warmupOnInit: block.warmupOnInit === true,
  }
}

/** Real fetch adapter (matches wigoloClient's expected {ok,status,text}). */
async function realFetch(url, init) {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body })
  return { ok: res.ok, status: res.status, text: () => res.text() }
}

/** Build a configured WigoloClient from ctx (settings + vault). */
export function buildClient(ctx = {}, fetchImpl) {
  const cfg = resolveConfig(ctx)
  const impl = typeof fetchImpl === 'function' ? fetchImpl : realFetch
  return { client: new WigoloClient({ baseUrl: cfg.restUrl, token: cfg.token, fetchImpl: impl }), config: cfg }
}

// ─── formatting helpers (pure) ─────────────────────────────────────────────

/** Normalize a search result set into compact rows for the agent + panel. */
export function toResultRows(payload) {
  const results = payload?.results ?? (Array.isArray(payload) ? payload : [])
  if (!Array.isArray(results)) return []
  return results.map((r) => ({
    title: r.title ?? r.url,
    url: r.url,
    excerpt: (r.excerpt ?? r.description ?? '').slice(0, 240),
    citation: r.citation_id ?? r.id,
    score: r.evidence_score?.final ?? r.score,
    freshness: payload?.freshness_signal?.published ?? r.published,
  }))
}

/** Normalize a fetch/crawl result into a compact summary. */
export function toPageSummary(payload) {
  if (!payload || typeof payload !== 'object') return {}
  const links = Array.isArray(payload.links) ? payload.links : []
  return {
    url: payload.url ?? payload.final_url,
    title: payload.title,
    markdown: typeof payload.markdown === 'string' ? payload.markdown.slice(0, 4000) : undefined,
    linkCount: links.length,
    links: links.slice(0, 20),
    blocked: payload.blocked_by_challenge === true || payload.status === 'blocked',
    sections: Array.isArray(payload.sections) ? payload.sections.length : undefined,
  }
}

/** Normalize a research result: the evidence + citations RTerm's agent synthesizes from. */
export function toResearchBrief(payload) {
  if (!payload || typeof payload !== 'object') return { evidence: [] }
  const evidence = payload.evidence ?? payload.results ?? payload.sources ?? []
  const citations = payload.citations ?? []
  return {
    question: payload.question,
    brief: payload.brief ?? payload.summary,
    evidence: (Array.isArray(evidence) ? evidence : []).map((e) => ({
      title: e.title ?? e.url,
      url: e.url,
      excerpt: (e.excerpt ?? e.snippet ?? '').slice(0, 300),
      citation: e.citation_id ?? e.id,
    })),
    citations: Array.isArray(citations) ? citations : [],
    note: 'Synthesis is done by the RTerm agent from this evidence — no LLM key needed.',
  }
}

/** Map a watch list payload into rows. */
export function toWatchRows(payload) {
  const items = payload?.watches ?? payload?.items ?? (Array.isArray(payload) ? payload : [])
  if (!Array.isArray(items)) return []
  return items.map((w) => ({
    id: w.id ?? w.watch_id,
    url: w.url,
    lastChecked: w.last_checked ?? w.checked_at,
    changed: w.changed === true,
    webhook: w.webhook,
  }))
}

/** Fires when a watch reports a page change. */
export function isPageChangedEvent(event) {
  if (event?.source !== 'webintel') return false
  return event?.changed === true || event?.kind === 'page_changed'
}

// ─── unreachable-daemon helper ─────────────────────────────────────────────

async function guarded(fn, log) {
  try {
    return await fn()
  } catch (e) {
    const msg = e?.message ?? String(e)
    log?.(`[web-intel] ${msg}`)
    return { error: msg, hint: 'Is the wigolo daemon running? The web-intel plugin starts it on first use (npx -y wigolo serve), or run it yourself. Configure the URL in Settings → webIntel.' }
  }
}

// ─── plugin entry ───────────────────────────────────────────────────────────

export function register(ctx) {
  const { registerTool, registerTrigger, registerPanel, log } = ctx
  // Allow tests/runtimes to inject a fetch; default to the real one.
  const { client, config } = buildClient(ctx, typeof ctx.fetchImpl === 'function' ? ctx.fetchImpl : undefined)

  // Sidecar lifecycle (lazy, lean). Spawn is best-effort — in runtimes where a
  // real child_process spawn is available the daemon starts on first use; in
  // tests the spawnImpl is injected/mocked.
  const sidecar = new WigoloSidecar({
    spawnImpl: ctx.spawnProcess,
    log,
    config: { warmup: config.warmupOnInit, token: config.token },
  })

  async function ensureDaemon() {
    if (!config.enabled) throw new Error('web-intel is disabled in Settings → webIntel')
    // Probe the daemon; start it if it's down and autoStart is on.
    const h = await client.health()
    if (h.ok) return true
    if (!config.autoStart) throw new Error(`wigolo daemon not reachable at ${config.restUrl} and autoStart is off`)
    if (typeof ctx.spawnProcess !== 'function') {
      throw new Error(`wigolo daemon not reachable at ${config.restUrl}. Start it: npx -y wigolo serve`)
    }
    await sidecar.start()
    // Best-effort: wait briefly for it to come up, but never block hard.
    const deadline = Date.now() + 8000
    for (;;) {
      const probe = await client.health()
      if (probe.ok) break
      if (Date.now() > deadline) throw new Error(`wigolo daemon did not become ready at ${config.restUrl} in time`)
      await new Promise((r) => setTimeout(r, 300))
    }
    // Lean default: only pre-download the heavy models if the user opted in.
    if (config.warmupOnInit) void sidecar.warmupInBackground()
    return true
  }

  // Tool: webintel_health — is the daemon up + what's its status.
  registerTool({
    name: 'webintel_health',
    description: 'Check the wigolo web-intelligence daemon status: reachable, lean vs full warmup, and whether it auto-started. Use this first if any web_* tool errors.',
    params: {},
    handler: async () => guarded(async () => {
      const h = await client.health()
      return {
        restUrl: config.restUrl,
        enabled: config.enabled,
        autoStart: config.autoStart,
        daemonUp: h.ok,
        sidecar: sidecar.status(),
        ...(h.ok ? { daemon: h.status } : { hint: 'Start it: npx -y wigolo serve (the plugin also auto-starts it on first use).' }),
      }
    }, log),
  })

  // Tool: web_search — multi-engine web search with ranked, citation-carrying results.
  registerTool({
    name: 'web_search',
    description: 'Search the web (multi-engine, ranked, citation-carrying) for an ops question. Pass a query string or an array for parallel breadth. Returns ranked results with excerpts + citations the agent can quote. Keyless, $0.',
    params: {
      query: { type: ['string', 'array'], description: 'Search query (string) or array of queries for parallel breadth' },
      timeRange: { type: 'string', description: "Optional time scope e.g. 'day'|'week'|'month'|'year'", optional: true },
      domain: { type: 'string', description: 'Optional domain to scope the search to', optional: true },
      maxResults: { type: 'number', description: 'Max results (default daemon setting)', optional: true },
    },
    handler: async (p) => guarded(async () => {
      await ensureDaemon()
      if (!p?.query) return { error: 'web_search needs a query' }
      const r = await client.search(p.query, {
        ...(p.timeRange ? { time_range: p.timeRange } : {}),
        ...(p.domain ? { domain: p.domain } : {}),
        ...(typeof p.maxResults === 'number' ? { max_results: p.maxResults } : {}),
      })
      return { results: toResultRows(r), freshness: r?.freshness_signal }
    }, log),
  })

  // Tool: web_fetch — fetch one URL as clean markdown (handles JS/SPA/anti-bot).
  registerTool({
    name: 'web_fetch',
    description: 'Fetch one URL as clean markdown + metadata + links (tiered router escalates to a browser engine for JS/SPA/anti-bot pages). Use for a specific doc/advisory/page the agent needs to read.',
    params: {
      url: { type: 'string', description: 'The URL to fetch' },
      section: { type: 'string', description: 'Optional single heading/section to extract', optional: true },
      mode: { type: 'string', description: "Optional 'cache'|'default'|'stealth'", optional: true },
    },
    handler: async (p) => guarded(async () => {
      await ensureDaemon()
      if (!p?.url) return { error: 'web_fetch needs a url' }
      const r = await client.fetch(p.url, {
        ...(p.section ? { section: p.section } : {}),
        ...(p.mode ? { mode: p.mode } : {}),
      })
      return toPageSummary(r)
    }, log),
  })

  // Tool: web_crawl — multi-page crawl of a site (BFS/DFS/sitemap/map-only).
  registerTool({
    name: 'web_crawl',
    description: 'Crawl a site (BFS/DFS/sitemap/map-only) with rate limits + robots.txt respect. Use to map a docs site or pull many pages. Returns per-page summaries + links.',
    params: {
      url: { type: 'string', description: 'Start URL' },
      strategy: { type: 'string', description: "Optional 'bfs'|'dfs'|'sitemap'|'map'", optional: true },
      maxPages: { type: 'number', description: 'Max pages to crawl', optional: true },
    },
    handler: async (p) => guarded(async () => {
      await ensureDaemon()
      if (!p?.url) return { error: 'web_crawl needs a url' }
      const r = await client.crawl(p.url, {
        ...(p.strategy ? { strategy: p.strategy } : {}),
        ...(typeof p.maxPages === 'number' ? { max_pages: p.maxPages } : {}),
      })
      const pages = Array.isArray(r?.pages) ? r.pages.map(toPageSummary) : [toPageSummary(r)]
      return { startUrl: p.url, pageCount: pages.length, pages }
    }, log),
  })

  // Tool: web_research — decompose a question into evidence + citations; RTerm's
  // agent synthesizes the cited answer (NO LLM key needed).
  registerTool({
    name: 'web_research',
    description: 'Research a question across the web: wigolo decomposes it, fans out sub-queries, fetches sources, and returns ranked evidence + citations. RTerm\'s agent then writes the cited answer from the brief — no LLM key needed. Use for current-doc-grounded answers (release notes, CVEs, errors, best practices).',
    params: {
      question: { type: 'string', description: 'The research question' },
      maxSources: { type: 'number', description: 'Max sources to gather', optional: true },
    },
    handler: async (p) => guarded(async () => {
      await ensureDaemon()
      if (!p?.question) return { error: 'web_research needs a question' }
      const r = await client.research(p.question, {
        ...(typeof p.maxSources === 'number' ? { max_sources: p.maxSources } : {}),
      })
      return toResearchBrief(r)
    }, log),
  })

  // Tool: web_find_similar — pages similar to a URL/concept.
  registerTool({
    name: 'web_find_similar',
    description: 'Find pages similar to a URL or concept (keyword + semantic + live web fusion). Use to find related advisories/docs.',
    params: {
      url: { type: 'string', description: 'The reference URL (or concept)', optional: true },
      concept: { type: 'string', description: 'A concept to find similar pages for', optional: true },
      maxResults: { type: 'number', optional: true },
    },
    handler: async (p) => guarded(async () => {
      await ensureDaemon()
      const input = p?.url ?? p?.concept
      if (!input) return { error: 'web_find_similar needs a url or concept' }
      const r = await client.findSimilar(input, {
        ...(typeof p.maxResults === 'number' ? { max_results: p.maxResults } : {}),
      })
      return { results: toResultRows(r) }
    }, log),
  })

  // Tool: web_watch_add — watch a page for changes; fires webintel_page_changed.
  registerTool({
    name: 'web_watch_add',
    description: 'Watch a page (vendor advisory, CVE, status page, doc) for changes. When it changes, the webintel_page_changed trigger fires so you can run a playbook or propose a change. Deliver to a webhook or poll.',
    params: {
      url: { type: 'string', description: 'The page URL to watch' },
      interval: { type: 'string', description: "Optional check interval e.g. '1h'|'6h'|'1d'", optional: true },
      webhook: { type: 'string', description: 'Optional webhook URL to deliver changes to', optional: true },
    },
    handler: async (p) => guarded(async () => {
      await ensureDaemon()
      if (!p?.url) return { error: 'web_watch_add needs a url' }
      const r = await client.watch('create', {
        url: p.url,
        ...(p.interval ? { interval: p.interval } : {}),
        ...(p.webhook ? { webhook: p.webhook } : {}),
      })
      return { created: true, watch: r }
    }, log),
  })

  // Tool: web_watch_list — list active page watches.
  registerTool({
    name: 'web_watch_list',
    description: 'List active page watches (url, last-checked, changed flag).',
    params: {},
    handler: async () => guarded(async () => {
      await ensureDaemon()
      const r = await client.watch('list')
      return { watches: toWatchRows(r) }
    }, log),
  })

  // Tool: web_watch_remove — stop watching a page.
  registerTool({
    name: 'web_watch_remove',
    description: 'Stop watching a page by watch id or URL.',
    params: {
      id: { type: 'string', description: 'The watch id (or URL)', optional: true },
      url: { type: 'string', description: 'The watched URL', optional: true },
    },
    handler: async (p) => guarded(async () => {
      await ensureDaemon()
      if (!p?.id && !p?.url) return { error: 'web_watch_remove needs an id or url' }
      const r = await client.watch('remove', { ...(p.id ? { id: p.id } : {}), ...(p.url ? { url: p.url } : {}) })
      return { removed: true, result: r }
    }, log),
  })

  // Trigger: webintel_page_changed — fires when a watched page changes.
  registerTrigger({
    name: 'webintel_page_changed',
    description: 'Fires when a watched page (web_watch_add) reports a change. Use for auto-remediation, CVE/vendor-advisory response, or doc-change playbooks.',
    match: (event) => isPageChangedEvent(event),
    action: 'propose-change',
  })

  // Panel: web-intel — watched pages + daemon status.
  registerPanel({
    name: 'web-intel',
    title: 'Web Intelligence',
    render: (data) => {
      const watches = (Array.isArray(data?.watches) ? data.watches : [])
        .map((w) => `<tr><td>${w.url ?? ''}</td><td>${w.changed ? 'changed' : '—'}</td><td>${w.lastChecked ?? ''}</td></tr>`)
        .join('')
      return `<div class="web-intel"><h3>Web Intelligence (wigolo)</h3><p>Daemon: ${config.restUrl} · warmup: ${config.warmupOnInit ? 'full' : 'lean'} · synthesis: RTerm agent (no LLM key)</p><h4>Watched pages</h4><table><thead><tr><th>URL</th><th>Changed</th><th>Last checked</th></tr></thead><tbody>${watches || '<tr><td colspan="3">No watches yet — web_watch_add to monitor a page.</td></tr>'}</tbody></table></div>`
    },
  })

  log(`[web-intel] web-intel registered: 8 tools, 1 trigger, 1 panel (daemon=${config.restUrl}, warmup=${config.warmupOnInit ? 'full' : 'lean'})`)
}

export default {
  register,
  resolveConfig,
  buildClient,
  toResultRows,
  toPageSummary,
  toResearchBrief,
  toWatchRows,
  isPageChangedEvent,
}
