import type { DashboardState } from './dashboardService'

/**
 * renderDashboardHtml — renders the unified dashboard:state as a self-contained
 * HTML page (browser-viewable, no build step, auto-refreshes). Pure: takes a
 * DashboardState + options, returns an HTML string. The gateway serves this on
 * an HTTP endpoint so anyone can open the live dashboard in a browser.
 *
 * Design goals:
 *   - Self-contained (inline CSS, no external deps) — opens in any browser.
 *   - Live-feeling: a <meta> refresh + a small JS fetch loop re-pulls state.
 *   - Themed to match RTerm's Aurora design (deep-space bg, cyan→violet accent).
 */

export interface RenderOptions {
  title?: string
  /** auto-refresh interval in seconds (default 10; 0 disables). */
  refreshSeconds?: number
  /** the URL the JS fetch loop re-pulls (default same path). */
  dataUrl?: string
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function pct(v: number | undefined): string {
  return typeof v === 'number' ? `${v.toFixed(1)}%` : '—'
}
function num(v: number | undefined, d = 1): string {
  return typeof v === 'number' ? v.toFixed(d) : '—'
}
function stateBadge(state: string): string {
  const c = state === 'up' ? 'ok' : state === 'degraded' ? 'warn' : state === 'down' ? 'bad' : 'mute'
  return `<span class="badge ${c}">${esc(state)}</span>`
}
function sevBadge(sev: string): string {
  const c = sev === 'sev1' || sev === 'sev2' ? 'bad' : sev === 'sev3' ? 'warn' : 'mute'
  return `<span class="badge ${c}">${esc(sev)}</span>`
}
function burnClass(burning: boolean): string {
  return burning ? 'bad' : 'ok'
}

export function renderDashboardHtml(state: DashboardState, opts: RenderOptions = {}): string {
  const title = opts.title ?? 'RTerm · Unified Dashboard'
  const refresh = opts.refreshSeconds ?? 10
  const dataUrl = opts.dataUrl ?? ''

  const hostRows = state.hosts.map((h) => {
    const g = h.golden
    const up = state.uptime.find((u) => u.target.name === h.host)
    return `<tr>
      <td class="host">${esc(h.host)}</td>
      <td>${up ? stateBadge(up.state) : '<span class="badge mute">—</span>'}</td>
      <td>${pct(g?.cpuPercent)}</td>
      <td>${pct(g?.memPercent)}</td>
      <td>${pct(g?.diskPercentMax)}</td>
      <td>${num(g?.cpuTrendPerDay, 2)}/d</td>
      <td>${g?.diskDaysToFull !== undefined ? num(g.diskDaysToFull, 1) + 'd' : '—'}</td>
    </tr>`
  }).join('\n')

  const sloRows = state.slos.map((e) => {
    const sli = e.sli !== undefined ? `${(e.sli * 100).toFixed(2)}%` : '—'
    const burn = e.burnRate !== undefined ? `${e.burnRate.toFixed(2)}x` : '—'
    const budget = e.errorBudgetRemaining !== undefined ? `${(e.errorBudgetRemaining * 100).toFixed(0)}%` : '—'
    return `<tr class="${e.fastBurning ? 'row-bad' : ''}">
      <td class="host">${esc(e.sloId)}</td>
      <td>${sli}</td><td>${burn}</td><td>${budget}</td>
      <td><span class="badge ${burnClass(e.fastBurning)}">${e.fastBurning ? 'FAST-BURNING' : 'healthy'}</span></td>
    </tr>`
  }).join('\n')

  const upRows = state.uptime.map((u) => `<tr>
      <td class="host">${esc(u.target.name)}</td>
      <td>${stateBadge(u.state)}</td>
      <td>${u.consecutiveFailures}</td>
      <td>${u.lastLatencyMs !== undefined ? u.lastLatencyMs + 'ms' : '—'}</td>
      <td>${esc(u.lastError ?? '')}</td>
    </tr>`).join('\n')

  const incRows = state.incidents.map((i) => `<tr>
      <td class="host">${esc(i.title)}</td>
      <td>${sevBadge(i.severity)}</td>
      <td><span class="badge ${i.status === 'open' ? 'bad' : i.status === 'mitigated' ? 'warn' : 'ok'}">${esc(i.status)}</span></td>
      <td>${esc(i.affected.join(', ') || '—')}</td>
      <td class="dim">${esc((i.rca ?? '').slice(0, 120))}</td>
    </tr>`).join('\n')

  const apmSvcRows = state.apm.bottleneckServices.map((s) => `<tr>
      <td class="host">${esc(s.service)}</td>
      <td>${s.spanCount}</td>
      <td>${s.errorCount}</td>
      <td>${(s.errorRate * 100).toFixed(1)}%</td>
      <td>${s.p95Ms !== undefined ? num(s.p95Ms, 0) + 'ms' : '—'}</td>
    </tr>`).join('\n')

  const apmTraceRows = state.apm.slowestTraces.map((t) => `<tr>
      <td class="host dim">${esc(t.traceId.slice(0, 16))}</td>
      <td>${esc(t.rootService)}</td>
      <td>${t.spanCount}</td>
      <td>${num(t.totalDurationMs, 0)}ms</td>
      <td>${t.hasError ? '<span class="badge bad">error</span>' : '<span class="badge ok">ok</span>'}</td>
    </tr>`).join('\n')

  const demRows = state.dem.slowestPages.map((p) => `<tr>
      <td class="host">${esc(p.page)}</td>
      <td>${p.sessions}</td>
      <td>${p.p75LcpMs !== undefined ? num(p.p75LcpMs, 0) + 'ms' : '—'}</td>
      <td>${p.p75InpMs !== undefined ? num(p.p75InpMs, 0) + 'ms' : '—'}</td>
      <td>${(p.errorRate * 100).toFixed(1)}%</td>
    </tr>`).join('\n')

  const clusterRows = state.clusters.map((c) => `<tr>
      <td class="host">${esc(c.context)}</td>
      <td>${c.runningPods}/${c.totalPods}</td>
      <td>${c.notReadyPods}</td>
      <td>${c.crashLoopPods}</td>
      <td>${c.totalRestarts}</td>
      <td>${c.nodesReady}/${c.nodesTotal}</td>
    </tr>`).join('\n')

  const capRows = state.capacity.map((c) => `<tr class="${c.daysToFull !== undefined && c.daysToFull < 30 ? 'row-bad' : ''}">
      <td class="host">${esc(c.host)}</td>
      <td>${pct(c.diskPercent)}</td>
      <td>${c.daysToFull !== undefined ? num(c.daysToFull, 1) + ' days' : '—'}</td>
    </tr>`).join('\n')

  const section = (id: string, label: string, rows: string, emptyMsg: string) =>
    rows
      ? `<section id="${id}"><h2>${label}</h2><table>${rows}</table></section>`
      : `<section id="${id}"><h2>${label}</h2><p class="empty">${esc(emptyMsg)}</p></section>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh > 0 ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>${esc(title)}</title>
<style>
  :root {
    --bg: #070a12; --panel: #0d1322; --panel2: #0a0f1b; --border: rgba(148,178,255,0.12);
    --fg: rgba(244,247,255,0.96); --muted: rgba(160,174,215,0.6);
    --accent: #4fd8e8; --accent2: #8b7bff; --ok: #3ddc97; --warn: #ffc44d; --bad: #ff5d7e;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial; font-size: 13px;
    background-image: radial-gradient(1100px 700px at 6% -12%, rgba(79,216,232,0.08), transparent 60%), radial-gradient(1000px 680px at 104% -6%, rgba(139,123,255,0.07), transparent 56%); }
  header { padding: 18px 26px; border-bottom: 1px solid var(--border); display: flex; align-items: baseline; gap: 14px; position: sticky; top: 0; background: rgba(7,10,18,0.85); backdrop-filter: blur(10px); z-index: 5; }
  header h1 { font-size: 17px; font-weight: 700; margin: 0; background: linear-gradient(100deg, var(--accent), var(--accent2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
  header .sub { color: var(--muted); font-size: 11px; }
  header .live { margin-left: auto; font-size: 11px; color: var(--ok); display: flex; align-items: center; gap: 6px; }
  header .live::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 8px var(--ok); }
  main { padding: 18px 26px 40px; max-width: 1280px; margin: 0 auto; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; box-shadow: 0 12px 30px rgba(0,0,0,0.35); }
  section h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 10px; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; color: var(--muted); font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; padding: 4px 8px 6px 0; border-bottom: 1px solid var(--border); }
  td { padding: 6px 8px 6px 0; border-bottom: 1px solid rgba(148,178,255,0.07); color: var(--fg); }
  tr:last-child td { border-bottom: none; }
  .host { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 11.5px; }
  .dim { color: var(--muted); }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .badge.ok { background: rgba(61,220,151,0.14); color: var(--ok); }
  .badge.warn { background: rgba(255,196,77,0.14); color: var(--warn); }
  .badge.bad { background: rgba(255,93,126,0.16); color: var(--bad); }
  .badge.mute { background: rgba(160,174,215,0.12); color: var(--muted); }
  .row-bad td { background: rgba(255,93,126,0.05); }
  .empty { color: var(--muted); font-size: 12px; padding: 8px 0; }
  .span2 { grid-column: span 2; }
  footer { color: var(--muted); font-size: 11px; padding: 14px 26px 30px; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } .span2 { grid-column: span 1; } }
</style>
</head>
<body>
<header>
  <h1>RTerm · Unified Dashboard</h1>
  <span class="sub">${esc(title)}</span>
  <span class="live">LIVE · updated ${esc(new Date(state.at).toISOString().slice(11, 19))} UTC</span>
</header>
<main>
  <div class="grid">
    <section class="span2" id="fleet">
      <h2>Fleet health</h2>
      <table>
        <tr><th>host</th><th>state</th><th>cpu</th><th>mem</th><th>disk</th><th>cpu trend</th><th>disk full in</th></tr>
        ${hostRows || '<tr><td class="empty">No hosts reporting yet.</td></tr>'}
      </table>
    </section>

    ${section('slo', 'SLO board', sloRows ? `<tr><th>slo</th><th>sli</th><th>burn rate</th><th>budget</th><th>status</th></tr>${sloRows}` : '', 'No SLOs defined yet.')}
    ${section('uptime', 'Uptime', upRows ? `<tr><th>host</th><th>state</th><th>failures</th><th>latency</th><th>error</th></tr>${upRows}` : '', 'No watchdog targets yet.')}
    ${section('incidents', 'Open incidents', incRows ? `<tr><th>incident</th><th>sev</th><th>status</th><th>affected</th><th>rca</th></tr>${incRows}` : '', 'No open incidents.')}
    ${section('apm-svc', 'APM · bottleneck services', apmSvcRows ? `<tr><th>service</th><th>spans</th><th>errors</th><th>error rate</th><th>p95</th></tr>${apmSvcRows}` : '', 'No APM spans ingested yet.')}
    ${section('apm-trace', 'APM · slowest traces', apmTraceRows ? `<tr><th>trace</th><th>root</th><th>spans</th><th>duration</th><th>status</th></tr>${apmTraceRows}` : '', 'No traces yet.')}
    ${section('dem', 'DEM · slowest pages (Core Web Vitals)', demRows ? `<tr><th>page</th><th>sessions</th><th>p75 lcp</th><th>p75 inp</th><th>error rate</th></tr>${demRows}` : '', 'No RUM sessions yet.')}
    ${section('clusters', 'Kubernetes / cloud clusters', clusterRows ? `<tr><th>context</th><th>pods</th><th>not ready</th><th>crashloop</th><th>restarts</th><th>nodes</th></tr>${clusterRows}` : '', 'No clusters reporting yet.')}
    ${section('capacity', 'Capacity forecast', capRows ? `<tr><th>host</th><th>disk</th><th>full in</th></tr>${capRows}` : '', 'No capacity data yet.')}
  </div>
</main>
<footer>
  RTerm Unified Dashboard · ${state.hosts.length} hosts · ${state.slos.length} SLOs · ${state.incidents.length} open incidents
  ${refresh > 0 ? `· auto-refresh ${refresh}s` : ''}
  ${dataUrl ? `· data: ${esc(dataUrl)}` : ''}
</footer>
</body>
</html>`
}
