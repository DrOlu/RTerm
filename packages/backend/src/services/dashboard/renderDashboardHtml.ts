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
  /** when true, the page renders all sections with stable ids and a live JS
   * client can update them in place (WebSocket push + fetch fallback). */
  live?: boolean
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
  const live = opts.live === true

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

  const emptyMsg = (sectionId: string, fallback: string): string =>
    state.empty?.find((e) => e.section === sectionId)?.message ?? fallback

  const sitItems = state.situation ?? []
  const sitHtml = sitItems
    .map((s) => {
      const cls = s.severity === 'critical' ? 'bad' : s.severity === 'warning' ? 'warn' : 'ok'
      const act = s.action
        ? `<button class="act" data-action="${esc(s.action.type)}" data-target="${esc(s.action.target ?? '')}">${esc(s.action.label)}</button>`
        : ''
      return `<div class="sit ${cls}"><span class="badge ${cls}">${esc(s.severity)}</span><div><strong>${esc(s.title)}</strong><div class="dim">${esc(s.detail)}</div></div>${act}</div>`
    })
    .join('')

  const workBlock = (title: string, items: Array<{ name: string; ok: boolean | null; detail: string; action?: { type: string; target?: string; label: string } }>) => {
    if (!items.length) return ''
    const rows = items
      .map((w) => {
        const badge = w.ok === false ? 'bad' : w.ok === true ? 'ok' : 'mute'
        const act = w.action
          ? `<button class="act" data-action="${esc(w.action.type)}" data-target="${esc(w.action.target ?? '')}">${esc(w.action.label)}</button>`
          : ''
        return `<tr><td class="host">${esc(w.name)}</td><td><span class="badge ${badge}">${esc(w.detail)}</span></td><td>${act}</td></tr>`
      })
      .join('')
    return `<h3>${esc(title)}</h3><table>${rows}</table>`
  }
  const work = state.work
  const workHtml = work
    ? [
        workBlock('Playbooks', work.playbooks),
        workBlock('Triggers', work.triggers),
        workBlock('Scheduled tasks', work.scheduledTasks),
        workBlock('Agent runs', work.agentRuns),
      ].join('')
    : ''

  const section = (id: string, label: string, rows: string, emptyMsgText: string) =>
    live
      ? `<section><h2>${label}</h2><div id="${id}">${rows ? `<table>${rows}</table>` : `<p class="empty">${esc(emptyMsgText)}</p>`}</div></section>`
      : rows
        ? `<section id="${id}"><h2>${label}</h2><table>${rows}</table></section>`
        : `<section id="${id}"><h2>${label}</h2><p class="empty">${esc(emptyMsgText)}</p></section>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh > 0 && !live ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
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
  .sit-strip { display: flex; flex-direction: column; gap: 8px; }
  .sit { display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); }
  .sit.bad { border-color: rgba(255,93,126,0.35); background: rgba(255,93,126,0.06); }
  .sit.warn { border-color: rgba(255,196,77,0.3); background: rgba(255,196,77,0.05); }
  .sit.ok { border-color: rgba(61,220,151,0.25); }
  .sit strong { display: block; font-size: 13px; }
  .act { margin-left: auto; background: transparent; color: var(--accent); border: 1px solid rgba(79,216,232,0.35); border-radius: 6px; padding: 3px 8px; font-size: 11px; cursor: pointer; white-space: nowrap; }
  .act:hover { background: rgba(79,216,232,0.12); }
  section h3 { font-size: 11px; color: var(--muted); margin: 10px 0 6px; text-transform: uppercase; letter-spacing: 0.06em; }
  .filter { margin: 0 0 10px; padding: 6px 10px; width: 100%; max-width: 320px; background: var(--panel2); color: var(--fg); border: 1px solid var(--border); border-radius: 8px; }
  footer { color: var(--muted); font-size: 11px; padding: 14px 26px 30px; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } .span2 { grid-column: span 1; } }
</style>
</head>
<body>
<header>
  <h1>RTerm · Unified Dashboard</h1>
  <span class="sub">${esc(title)}</span>
  <span class="live" id="live-indicator">LIVE · updated ${esc(new Date(state.at).toISOString().slice(11, 19))} UTC</span>
</header>
<main>
  <section class="span2" id="situation-wrap">
    <h2>Situation</h2>
    <div class="sub dim" id="headline">${esc(state.headline || '')}</div>
    <div class="sit-strip" id="situation">${sitHtml || '<p class="empty">All clear.</p>'}</div>
  </section>
  <div class="grid">
    <section class="span2">
      <h2>Fleet health</h2>
      <input class="filter" id="host-filter" type="search" placeholder="Filter hosts…" />
      <div id="fleet">
      <table>
        <tr><th>host</th><th>state</th><th>cpu</th><th>mem</th><th>disk</th><th>cpu trend</th><th>disk full in</th></tr>
        ${hostRows || `<tr><td class="empty">${esc(emptyMsg('hosts', 'No hosts reporting yet. Open a terminal so Monitor can collect CPU/mem/disk, or add a watchdog target.'))}</td></tr>`}
      </table>
      </div>
    </section>

    <section class="span2" id="work-wrap">
      <h2>RTerm work</h2>
      <div id="work">${workHtml || '<p class="empty">No playbook runs, trigger fires, scheduled tasks, or agent runs yet.</p>'}</div>
    </section>

    ${section('slo', 'SLO board', sloRows ? `<tr><th>slo</th><th>sli</th><th>burn rate</th><th>budget</th><th>status</th></tr>${sloRows}` : '', emptyMsg('slos', 'No SLOs defined yet. Define an SLO to track error budget and burn rate.'))}
    ${section('uptime', 'Uptime', upRows ? `<tr><th>host</th><th>state</th><th>failures</th><th>latency</th><th>error</th></tr>${upRows}` : '', emptyMsg('uptime', 'No watchdog targets yet. Uptime probes appear here once a host is watched.'))}
    ${section('incidents', 'Open incidents', incRows ? `<tr><th>incident</th><th>sev</th><th>status</th><th>affected</th><th>rca</th></tr>${incRows}` : '', emptyMsg('incidents', 'No open incidents.'))}
    ${section('apm-svc', 'APM · bottleneck services', apmSvcRows ? `<tr><th>service</th><th>spans</th><th>errors</th><th>error rate</th><th>p95</th></tr>${apmSvcRows}` : '', emptyMsg('apm', 'No APM spans ingested yet. Model calls and OTLP spans appear here when tracing is on.'))}
    ${section('apm-trace', 'APM · slowest traces', apmTraceRows ? `<tr><th>trace</th><th>root</th><th>spans</th><th>duration</th><th>status</th></tr>${apmTraceRows}` : '', emptyMsg('apm', 'No traces yet.'))}
    ${section('dem', 'DEM · slowest pages (Core Web Vitals)', demRows ? `<tr><th>page</th><th>sessions</th><th>p75 lcp</th><th>p75 inp</th><th>error rate</th></tr>${demRows}` : '', emptyMsg('dem', 'No RUM sessions yet. Core Web Vitals appear after DEM beacons are ingested.'))}
    ${section('clusters', 'Kubernetes / cloud clusters', clusterRows ? `<tr><th>context</th><th>pods</th><th>not ready</th><th>crashloop</th><th>restarts</th><th>nodes</th></tr>${clusterRows}` : '', emptyMsg('clusters', 'No Kubernetes clusters reporting yet. Run collect_infra / kubectl ingest to populate.'))}
    ${section('capacity', 'Capacity forecast', capRows ? `<tr><th>host</th><th>disk</th><th>full in</th></tr>${capRows}` : '', emptyMsg('capacity', 'No capacity forecast yet. Disk-days-to-full needs Monitor disk samples.'))}
  </div>
</main>
<footer>
  RTerm Unified Dashboard · ${state.hosts.length} hosts · ${state.slos.length} SLOs · ${state.incidents.length} open incidents
  ${refresh > 0 && !live ? `· auto-refresh ${refresh}s` : ''}
  ${dataUrl ? `· data: ${esc(dataUrl)}` : ''}
</footer>
${live ? liveDashboardClientScript(dataUrl || '/dashboard/json') : ''}
</body>
</html>`
}

/** The browser-side live client: subscribes to dashboard pushes over the
 * gateway WebSocket (observability:liveDashboardSubscribe) and re-renders each
 * section in place; falls back to polling the JSON endpoint when WS is
 * unavailable. All rendering is plain DOM string building (no deps). */
function liveDashboardClientScript(jsonUrl: string): string {
  return `<script>
(function () {
  'use strict';
  var JSON_URL = ${JSON.stringify(jsonUrl)};
  var wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/';
  var indicator = document.getElementById('live-indicator');
  var pollTimer = null;
  var rpcId = 0;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function pct(v) { return typeof v === 'number' ? v.toFixed(1) + '%' : '\\u2014'; }
  function num(v, d) { return typeof v === 'number' ? v.toFixed(d == null ? 1 : d) : '\\u2014'; }
  function badge(state) {
    var c = state === 'up' ? 'ok' : state === 'degraded' ? 'warn' : state === 'down' ? 'bad' : 'mute';
    return '<span class="badge ' + c + '">' + esc(state) + '</span>';
  }
  function sev(sev) {
    var c = sev === 'sev1' || sev === 'sev2' ? 'bad' : sev === 'sev3' ? 'warn' : 'mute';
    return '<span class="badge ' + c + '">' + esc(sev) + '</span>';
  }
  function setSection(id, tableHtml, emptyMsg) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = tableHtml || '<p class="empty">' + esc(emptyMsg) + '</p>';
  }
  function render(s) {
    if (!s || typeof s !== 'object') return;
    var hostRows = (s.hosts || []).map(function (h) {
      var g = h.golden || {};
      var up = (s.uptime || []).find(function (u) { return u.target && u.target.name === h.host; });
      return '<tr><td class="host">' + esc(h.host) + '</td><td>' + (up ? badge(up.state) : '<span class="badge mute">\\u2014</span>') + '</td><td>' + pct(g.cpuPercent) + '</td><td>' + pct(g.memPercent) + '</td><td>' + pct(g.diskPercentMax) + '</td><td>' + num(g.cpuTrendPerDay, 2) + '/d</td><td>' + (g.diskDaysToFull !== undefined ? num(g.diskDaysToFull, 1) + 'd' : '\\u2014') + '</td></tr>';
    }).join('');
    setSection('fleet', '<table><tr><th>host</th><th>state</th><th>cpu</th><th>mem</th><th>disk</th><th>cpu trend</th><th>disk full in</th></tr>' + hostRows + '</table>', 'No hosts reporting yet.');

    var sloRows = (s.slos || []).map(function (e) {
      return '<tr class="' + (e.fastBurning ? 'row-bad' : '') + '"><td class="host">' + esc(e.sloId) + '</td><td>' + (e.sli !== undefined ? (e.sli * 100).toFixed(2) + '%' : '\\u2014') + '</td><td>' + (e.burnRate !== undefined ? e.burnRate.toFixed(2) + 'x' : '\\u2014') + '</td><td>' + (e.errorBudgetRemaining !== undefined ? (e.errorBudgetRemaining * 100).toFixed(0) + '%' : '\\u2014') + '</td><td><span class="badge ' + (e.fastBurning ? 'bad' : 'ok') + '">' + (e.fastBurning ? 'FAST-BURNING' : 'healthy') + '</span></td></tr>';
    }).join('');
    setSection('slo', sloRows ? '<table><tr><th>slo</th><th>sli</th><th>burn rate</th><th>budget</th><th>status</th></tr>' + sloRows + '</table>' : '', 'No SLOs defined yet.');

    var upRows = (s.uptime || []).map(function (u) {
      return '<tr><td class="host">' + esc(u.target && u.target.name) + '</td><td>' + badge(u.state) + '</td><td>' + u.consecutiveFailures + '</td><td>' + (u.lastLatencyMs !== undefined ? u.lastLatencyMs + 'ms' : '\\u2014') + '</td><td>' + esc(u.lastError || '') + '</td></tr>';
    }).join('');
    setSection('uptime', upRows ? '<table><tr><th>host</th><th>state</th><th>failures</th><th>latency</th><th>error</th></tr>' + upRows + '</table>' : '', 'No watchdog targets yet.');

    var incRows = (s.incidents || []).map(function (i) {
      return '<tr><td class="host">' + esc(i.title) + '</td><td>' + sev(i.severity) + '</td><td><span class="badge ' + (i.status === 'open' ? 'bad' : i.status === 'mitigated' ? 'warn' : 'ok') + '">' + esc(i.status) + '</span></td><td>' + esc((i.affected || []).join(', ') || '\\u2014') + '</td><td class="dim">' + esc((i.rca || '').slice(0, 120)) + '</td></tr>';
    }).join('');
    setSection('incidents', incRows ? '<table><tr><th>incident</th><th>sev</th><th>status</th><th>affected</th><th>rca</th></tr>' + incRows + '</table>' : '', 'No open incidents.');

    var apmSvc = ((s.apm && s.apm.bottleneckServices) || []).map(function (x) {
      return '<tr><td class="host">' + esc(x.service) + '</td><td>' + x.spanCount + '</td><td>' + x.errorCount + '</td><td>' + (x.errorRate * 100).toFixed(1) + '%</td><td>' + (x.p95Ms !== undefined ? num(x.p95Ms, 0) + 'ms' : '\\u2014') + '</td></tr>';
    }).join('');
    setSection('apm-svc', apmSvc ? '<table><tr><th>service</th><th>spans</th><th>errors</th><th>error rate</th><th>p95</th></tr>' + apmSvc + '</table>' : '', 'No APM spans ingested yet.');

    var apmTr = ((s.apm && s.apm.slowestTraces) || []).map(function (t) {
      return '<tr><td class="host dim">' + esc(String(t.traceId).slice(0, 16)) + '</td><td>' + esc(t.rootService) + '</td><td>' + t.spanCount + '</td><td>' + num(t.totalDurationMs, 0) + 'ms</td><td>' + (t.hasError ? '<span class="badge bad">error</span>' : '<span class="badge ok">ok</span>') + '</td></tr>';
    }).join('');
    setSection('apm-trace', apmTr ? '<table><tr><th>trace</th><th>root</th><th>spans</th><th>duration</th><th>status</th></tr>' + apmTr + '</table>' : '', 'No traces yet.');

    var demRows = ((s.dem && s.dem.slowestPages) || []).map(function (p) {
      return '<tr><td class="host">' + esc(p.page) + '</td><td>' + p.sessions + '</td><td>' + (p.p75LcpMs !== undefined ? num(p.p75LcpMs, 0) + 'ms' : '\\u2014') + '</td><td>' + (p.p75InpMs !== undefined ? num(p.p75InpMs, 0) + 'ms' : '\\u2014') + '</td><td>' + (p.errorRate * 100).toFixed(1) + '%</td></tr>';
    }).join('');
    setSection('dem', demRows ? '<table><tr><th>page</th><th>sessions</th><th>p75 lcp</th><th>p75 inp</th><th>error rate</th></tr>' + demRows + '</table>' : '', 'No RUM sessions yet.');

    var clRows = (s.clusters || []).map(function (c) {
      return '<tr><td class="host">' + esc(c.context) + '</td><td>' + c.runningPods + '/' + c.totalPods + '</td><td>' + c.notReadyPods + '</td><td>' + c.crashLoopPods + '</td><td>' + c.totalRestarts + '</td><td>' + c.nodesReady + '/' + c.nodesTotal + '</td></tr>';
    }).join('');
    setSection('clusters', clRows ? '<table><tr><th>context</th><th>pods</th><th>not ready</th><th>crashloop</th><th>restarts</th><th>nodes</th></tr>' + clRows + '</table>' : '', 'No clusters reporting yet.');

    var capRows = (s.capacity || []).map(function (c) {
      return '<tr class="' + (c.daysToFull !== undefined && c.daysToFull < 30 ? 'row-bad' : '') + '"><td class="host">' + esc(c.host) + '</td><td>' + pct(c.diskPercent) + '</td><td>' + (c.daysToFull !== undefined ? num(c.daysToFull, 1) + ' days' : '\\u2014') + '</td></tr>';
    }).join('');
    setSection('capacity', capRows ? '<table><tr><th>host</th><th>disk</th><th>full in</th></tr>' + capRows + '</table>' : '', 'No capacity data yet.');

    if (indicator) {
      var t = new Date(s.at || Date.now()).toISOString().slice(11, 19);
      indicator.textContent = 'LIVE \\u00b7 updated ' + t + ' UTC';
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      fetch(JSON_URL).then(function (r) { return r.json(); }).then(render).catch(function () {});
    }, 5000);
  }

  function connect() {
    var ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { startPolling(); return; }
    ws.onopen = function () {
      rpcId += 1;
      ws.send(JSON.stringify({ type: 'gateway:rpc', id: 'dash-' + rpcId, method: 'observability:liveDashboardSubscribe', params: {} }));
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg && msg.type === 'gateway:event' && msg.event === 'observability:dashboard' && msg.data) render(msg.data);
    };
    ws.onclose = function () { startPolling(); setTimeout(connect, 5000); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }
  connect();
})();
</` + `script>`
}

/** Render the dashboard as a LIVE page: initial state inlined, then the
 * embedded client keeps every section current via gateway WebSocket pushes
 * (falling back to polling the JSON endpoint). Served on /dashboard. */
export function renderLiveDashboardHtml(state: DashboardState, opts: RenderOptions = {}): string {
  return renderDashboardHtml(state, { ...opts, live: true, refreshSeconds: 0 })
}
