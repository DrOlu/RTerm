import { randomUUID } from 'crypto'

/**
 * RumLedger — DEM Tier: Real User Monitoring (sessions + Core Web Vitals).
 *
 * A tiny JS beacon on real pages POSTs page-load metrics (LCP, INP, CLS, TTFB)
 * to RTerm; this ledger stores sessions and answers UX questions per page/route/
 * region: p75 LCP/INP, error rate, UX trend. Pairs with SyntheticChecks (the
 * synthetic half of DEM). Pure + injectable; deterministic `now` for tests.
 */

export interface RumSession {
  id: string
  page: string
  /** route/path (e.g. /checkout). */
  route?: string
  region?: string
  userAgent?: string
  at: number
  /** Core Web Vitals (ms / unitless). */
  lcpMs?: number
  inpMs?: number
  cls?: number
  ttfbMs?: number
  /** page-level JS error flag/count. */
  jsErrors?: number
}

export interface RumPageStats {
  page: string
  sessions: number
  p75LcpMs?: number
  p75InpMs?: number
  avgCls?: number
  p75TtfbMs?: number
  errorRate: number
}

export interface RumLedgerOptions {
  now?: () => number
  /** max sessions retained (ring buffer; default 50_000). */
  sessionLimit?: number
}

const DEFAULT_LIMIT = 50_000

function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

export class RumLedger {
  private readonly sessions: RumSession[] = []
  private readonly now: () => number
  private readonly sessionLimit: number

  constructor(opts: RumLedgerOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.sessionLimit = opts.sessionLimit ?? DEFAULT_LIMIT
  }

  /** Ingest one RUM session (a page view). */
  ingest(session: Omit<RumSession, 'id' | 'at'> & { id?: string; at?: number }): RumSession {
    const s: RumSession = {
      ...session,
      id: session.id ?? `rum-${randomUUID().slice(0, 12)}`,
      at: session.at ?? this.now(),
    }
    this.sessions.push(s)
    if (this.sessions.length > this.sessionLimit) this.sessions.splice(0, this.sessions.length - this.sessionLimit)
    return s
  }

  /** Ingest a beacon payload (the JS snippet's POST body). */
  ingestBeacon(payload: unknown): RumSession | undefined {
    const p = payload as Partial<RumSession>
    if (!p || typeof p.page !== 'string') return undefined
    return this.ingest({
      page: p.page,
      ...(p.route ? { route: p.route } : {}),
      ...(p.region ? { region: p.region } : {}),
      ...(p.userAgent ? { userAgent: p.userAgent } : {}),
      ...(typeof p.lcpMs === 'number' ? { lcpMs: p.lcpMs } : {}),
      ...(typeof p.inpMs === 'number' ? { inpMs: p.inpMs } : {}),
      ...(typeof p.cls === 'number' ? { cls: p.cls } : {}),
      ...(typeof p.ttfbMs === 'number' ? { ttfbMs: p.ttfbMs } : {}),
      ...(typeof p.jsErrors === 'number' ? { jsErrors: p.jsErrors } : {}),
      ...(p.at ? { at: p.at } : {}),
    })
  }

  /** Sessions for a page (or all), optionally within a window. */
  sessionsFor(opts: { page?: string; sinceMs?: number } = {}): readonly RumSession[] {
    return this.sessions.filter((s) =>
      (opts.page === undefined || s.page === opts.page) &&
      (opts.sinceMs === undefined || s.at >= opts.sinceMs),
    )
  }

  /** Per-page UX stats over a window. */
  pageStats(opts: { sinceMs?: number; page?: string } = {}): RumPageStats[] {
    const byPage = new Map<string, RumSession[]>()
    for (const s of this.sessions) {
      if (opts.sinceMs !== undefined && s.at < opts.sinceMs) continue
      if (opts.page && s.page !== opts.page) continue
      let arr = byPage.get(s.page)
      if (!arr) { arr = []; byPage.set(s.page, arr) }
      arr.push(s)
    }
    const out: RumPageStats[] = []
    for (const [page, arr] of byPage) {
      const lcp = arr.map((s) => s.lcpMs).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b)
      const inp = arr.map((s) => s.inpMs).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b)
      const ttfb = arr.map((s) => s.ttfbMs).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b)
      const clsVals = arr.map((s) => s.cls).filter((x): x is number => typeof x === 'number')
      const errCount = arr.filter((s) => (s.jsErrors ?? 0) > 0).length
      out.push({
        page,
        sessions: arr.length,
        p75LcpMs: percentile(lcp, 75),
        p75InpMs: percentile(inp, 75),
        avgCls: clsVals.length > 0 ? clsVals.reduce((a, b) => a + b, 0) / clsVals.length : undefined,
        p75TtfbMs: percentile(ttfb, 75),
        errorRate: arr.length > 0 ? errCount / arr.length : 0,
      })
    }
    return out.sort((a, b) => (b.p75LcpMs ?? 0) - (a.p75LcpMs ?? 0))
  }

  /** Slowest pages by p75 LCP. */
  slowestPages(limit = 10, opts: { sinceMs?: number } = {}): RumPageStats[] {
    return this.pageStats(opts).sort((a, b) => (b.p75LcpMs ?? 0) - (a.p75LcpMs ?? 0)).slice(0, limit)
  }

  /** Pages exceeding a Core Web Vitals threshold (LCP > good threshold, default 2500ms). */
  poorPages(lcpThresholdMs = 2500, opts: { sinceMs?: number } = {}): RumPageStats[] {
    return this.pageStats(opts).filter((p) => (p.p75LcpMs ?? 0) > lcpThresholdMs)
  }

  size(): number {
    return this.sessions.length
  }

  clear(): void {
    this.sessions.length = 0
  }
}
