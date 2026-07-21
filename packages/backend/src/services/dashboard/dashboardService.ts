import type { MetricsLedger } from '../sre/metricsLedger'
import type { GoldenSignals, GoldenSignalReport } from '../sre/goldenSignals'
import type { SloService, SloEvaluation } from '../sre/sloService'
import type { UptimeWatchdog, HostStatus } from '../sre/uptimeWatchdog'
import type { IncidentLedger, Incident } from '../sre/incidentLedger'
import type { SpanLedger, ServiceStats, TraceSummary } from '../apm/spanLedger'
import type { RumLedger, RumPageStats } from '../dem/rumLedger'
import type { InfraMonitor, K8sClusterHealth } from '../infra/infraMonitor'

/**
 * DashboardService — a unified aggregation layer over every monitoring ledger.
 *
 * Composes infra (golden signals + uptime + k8s), SLO (SLI/burn-rate), incidents,
 * APM (spans/services), and DEM (RUM pages) into one `dashboard:state` object
 * that the gateway broadcasts to the Dashboard UI (and any WebSocket client) for
 * rich, live, cross-linked views. Pure + injectable: all ledgers are injected;
 * the aggregation is pure and deterministic.
 */

export interface DashboardHost {
  host: string
  golden?: GoldenSignalReport
  uptime?: HostStatus
}

export interface DashboardState {
  at: number
  /** per-host golden signals + uptime status (fleet health grid). */
  hosts: DashboardHost[]
  /** SLO board: SLI, error budget, burn rate per SLO. */
  slos: SloEvaluation[]
  /** uptime map: up/degraded/down per host. */
  uptime: readonly HostStatus[]
  /** incident feed: open (and recent) incidents. */
  incidents: Incident[]
  /** APM: bottleneck services + slowest traces. */
  apm: { bottleneckServices: ServiceStats[]; slowestTraces: TraceSummary[] }
  /** DEM: slowest/poor pages by Core Web Vitals. */
  dem: { slowestPages: RumPageStats[]; poorPages: RumPageStats[] }
  /** k8s/cloud cluster health. */
  clusters: K8sClusterHealth[]
  /** capacity forecast: days-to-disk-full per host. */
  capacity: Array<{ host: string; diskPercent?: number; daysToFull?: number }>
}

export interface DashboardDeps {
  metricsLedger: MetricsLedger
  goldenSignals: GoldenSignals
  sloService: SloService
  uptimeWatchdog: UptimeWatchdog
  incidentLedger: IncidentLedger
  spanLedger?: SpanLedger
  rumLedger?: RumLedger
  infraMonitor?: InfraMonitor
  now?: () => number
  /** max items per section (default 10). */
  sectionLimit?: number
}

const DEFAULT_LIMIT = 10

export class DashboardService {
  private readonly now: () => number
  private readonly limit: number

  constructor(private readonly deps: DashboardDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.limit = deps.sectionLimit ?? DEFAULT_LIMIT
  }

  /** Build the unified dashboard state. */
  async state(opts: { incidentStatus?: 'open' | 'mitigated' | 'resolved' } = {}): Promise<DashboardState> {
    const d = this.deps

    // Fleet health: golden signals + uptime per host.
    const golden = d.goldenSignals.reportAll()
    const uptime = d.uptimeWatchdog.allStatus()
    const goldenByHost = new Map(golden.map((g) => [g.host, g]))
    const uptimeByHost = new Map(uptime.map((u) => [u.target.name, u]))
    const allHosts = new Set<string>([...goldenByHost.keys(), ...uptimeByHost.keys()])
    const hosts: DashboardHost[] = Array.from(allHosts).map((host) => ({
      host,
      ...(goldenByHost.get(host) ? { golden: goldenByHost.get(host) } : {}),
      ...(uptimeByHost.get(host) ? { uptime: uptimeByHost.get(host) } : {}),
    }))

    // SLO board.
    const slos = await d.sloService.evaluateAll()

    // Incidents (open by default).
    const incidents = d.incidentLedger.list(opts.incidentStatus ? { status: opts.incidentStatus } : { status: 'open' }).slice(0, this.limit)

    // APM.
    const apm = d.spanLedger
      ? {
          bottleneckServices: d.spanLedger.bottleneckServices().slice(0, this.limit),
          slowestTraces: d.spanLedger.slowestTraces(this.limit),
        }
      : { bottleneckServices: [], slowestTraces: [] }

    // DEM.
    const dem = d.rumLedger
      ? {
          slowestPages: d.rumLedger.slowestPages(this.limit),
          poorPages: d.rumLedger.poorPages(2500).slice(0, this.limit),
        }
      : { slowestPages: [], poorPages: [] }

    // k8s/cloud clusters.
    const clusters = d.infraMonitor ? d.infraMonitor.clusters_().slice(0, this.limit) : []

    // Capacity forecast.
    const capacity = d.goldenSignals.capacityForecast()

    return {
      at: this.now(),
      hosts,
      slos,
      uptime,
      incidents,
      apm,
      dem,
      clusters,
      capacity,
    }
  }

  /** A compact summary line for the gateway/agent (e.g. "3 hosts, 1 degraded, 2 open incidents, 1 SLO fast-burning"). */
  async summary(): Promise<string> {
    const s = await this.state()
    const down = s.uptime.filter((u) => u.state === 'down').length
    const degraded = s.uptime.filter((u) => u.state === 'degraded').length
    const fastBurn = s.slos.filter((e) => e.fastBurning).length
    const openInc = s.incidents.length
    const parts = [
      `${s.hosts.length} hosts`,
      down > 0 ? `${down} down` : null,
      degraded > 0 ? `${degraded} degraded` : null,
      openInc > 0 ? `${openInc} open incident${openInc === 1 ? '' : 's'}` : 'no open incidents',
      fastBurn > 0 ? `${fastBurn} SLO fast-burning` : 'SLOs healthy',
    ]
    return parts.filter(Boolean).join(' · ')
  }
}
