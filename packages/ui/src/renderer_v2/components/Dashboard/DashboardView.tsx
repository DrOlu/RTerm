import React from 'react'
import { observer } from 'mobx-react-lite'
import { ArrowLeft, LayoutDashboard } from 'lucide-react'
import type { AppStore } from '../../stores/AppStore'
import {
  filterHostsByQuery,
  matchConnectionForHost,
  type DashboardAction,
} from './dashboardActions'
import './dashboard.scss'

interface DashState {
  headline?: string
  hosts?: Array<{
    host: string
    golden?: { cpuPercent?: number; memPercent?: number; diskPercentMax?: number }
  }>
  situation?: Array<{
    id: string
    severity: string
    title: string
    detail: string
    action?: DashboardAction
  }>
  work?: {
    playbooks: Array<{ id: string; name: string; detail: string; ok: boolean | null; action?: DashboardAction }>
    triggers: Array<{ id: string; name: string; detail: string; ok: boolean | null; action?: DashboardAction }>
    scheduledTasks: Array<{ id: string; name: string; detail: string; ok: boolean | null; action?: DashboardAction }>
    agentRuns: Array<{ id: string; name: string; detail: string; ok: boolean | null; action?: DashboardAction }>
  }
  empty?: Array<{ section: string; message: string }>
}

async function fetchDashboardState(gatewayPort?: number): Promise<DashState | null> {
  const ipc = (window as unknown as { gyshell?: { dashboard?: { state?: () => Promise<DashState> } } })
    .gyshell?.dashboard?.state
  if (typeof ipc === 'function') {
    try {
      const viaIpc = await ipc()
      if (viaIpc && typeof viaIpc === 'object') return viaIpc
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Old preload without dashboard:state — try HTTP. Real IPC errors surface.
      if (!/no handler|not a function|undefined/i.test(msg)) throw e
    }
  }
  const ports = [gatewayPort, 17888, 18789].filter(
    (p): p is number => typeof p === 'number' && p > 0 && p < 65536,
  )
  const unique = [...new Set(ports)]
  for (const port of unique) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/dashboard/json`, { cache: 'no-store' })
      if (!r.ok) continue
      return (await r.json()) as DashState
    } catch {
      /* try next */
    }
  }
  return null
}

export const DashboardView: React.FC<{ store: AppStore }> = observer(({ store }) => {
  const t = store.i18n.t
  const [state, setState] = React.useState<DashState | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState('')

  const load = React.useCallback(() => {
    const port = store.settings?.gateway?.ws?.port
    void fetchDashboardState(port)
      .then((s) => {
        setState(s)
        setError(
          s
            ? null
            : 'Dashboard is not reachable. In the desktop app this uses IPC; if you still see this, restart RTerm. For a headless gybackend, open the WS gateway (default :17888) and retry.',
        )
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [store.settings?.gateway?.ws?.port])

  React.useEffect(() => {
    load()
    const id = window.setInterval(load, 8000)
    return () => window.clearInterval(id)
  }, [load])

  const runAction = (action?: DashboardAction, hostFallback?: string) => {
    if (!action && !hostFallback) return
    const type = action?.type
    const target = action?.target || hostFallback
    if (type === 'open-host' || Boolean(hostFallback)) {
      const hit = matchConnectionForHost(target || '', {
        ssh: store.settings?.connections?.ssh ?? [],
        winrm: store.settings?.connections?.winrm ?? [],
      })
      store.closeOverlay()
      if (hit?.kind === 'ssh') store.createSshTab(hit.id)
      else if (hit?.kind === 'winrm') store.createWinrmTab(hit.id)
      return
    }
    if (type === 'open-connections') {
      store.openConnections()
      return
    }
    if (type === 'open-chat') {
      store.closeOverlay()
    }
  }

  const hosts = filterHostsByQuery(state?.hosts ?? [], query)
  const work = state?.work

  return (
    <div className="dashboard-view">
      <div className="dashboard-header">
        <button className="connections-back-btn" onClick={() => store.closeOverlay()} title={t.common.back}>
          <ArrowLeft size={16} strokeWidth={2} />
        </button>
        <LayoutDashboard size={16} />
        <div className="dashboard-title">Dashboard</div>
        <div className="dashboard-headline">{state?.headline || 'Loading…'}</div>
        <button className="dashboard-refresh" type="button" onClick={load}>
          Refresh
        </button>
      </div>
      {error ? <div className="dashboard-error">{error}</div> : null}
      <div className="dashboard-body">
        <section className="dashboard-card">
          <h2>Situation</h2>
          {(state?.situation ?? []).map((s) => (
            <div key={s.id} className={`dashboard-sit is-${s.severity}`}>
              <span className={`dash-badge ${s.severity}`}>{s.severity}</span>
              <div>
                <strong>{s.title}</strong>
                <div className="dim">{s.detail}</div>
              </div>
              {s.action ? (
                <button type="button" className="dash-act" onClick={() => runAction(s.action)}>
                  {s.action.label}
                </button>
              ) : null}
            </div>
          ))}
        </section>

        <section className="dashboard-card">
          <h2>Fleet</h2>
          <input
            className="dashboard-filter"
            placeholder="Filter hosts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <table>
            <thead>
              <tr>
                <th>host</th>
                <th>cpu</th>
                <th>mem</th>
                <th>disk</th>
              </tr>
            </thead>
            <tbody>
              {hosts.length ? (
                hosts.map((h) => (
                  <tr
                    key={h.host}
                    className="clickable"
                    onClick={() => runAction({ type: 'open-host', target: h.host, label: 'Open' }, h.host)}
                  >
                    <td className="host">{h.host}</td>
                    <td>{h.golden?.cpuPercent != null ? `${h.golden.cpuPercent.toFixed(1)}%` : '—'}</td>
                    <td>{h.golden?.memPercent != null ? `${h.golden.memPercent.toFixed(1)}%` : '—'}</td>
                    <td>{h.golden?.diskPercentMax != null ? `${h.golden.diskPercentMax.toFixed(1)}%` : '—'}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="empty">
                    {state?.empty?.find((e) => e.section === 'hosts')?.message || 'No hosts reporting yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="dashboard-card">
          <h2>RTerm work</h2>
          {work &&
            (['playbooks', 'triggers', 'scheduledTasks', 'agentRuns'] as const).map((key) => {
              const items = work[key]
              if (!items?.length) return null
              return (
                <div key={key}>
                  <h3>{key}</h3>
                  {items.map((w) => (
                    <div key={w.id} className="dashboard-work-row">
                      <span className="host">{w.name}</span>
                      <span className={`dash-badge ${w.ok === false ? 'critical' : w.ok ? 'info' : 'warning'}`}>
                        {w.detail}
                      </span>
                      {w.action ? (
                        <button type="button" className="dash-act" onClick={() => runAction(w.action)}>
                          {w.action.label}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              )
            })}
          {!work?.playbooks.length &&
          !work?.triggers.length &&
          !work?.scheduledTasks.length &&
          !work?.agentRuns.length ? (
            <p className="empty">No playbook runs, trigger fires, scheduled tasks, or agent runs yet.</p>
          ) : null}
        </section>
      </div>
    </div>
  )
})
