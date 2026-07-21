import { randomUUID } from 'crypto'

/**
 * InfraMonitor — Infra Tier: Kubernetes/container/cloud-service monitoring.
 *
 * Normalizes cluster/cloud inventory into metric points + liveness targets that
 * plug into the existing MetricsLedger/UptimeWatchdog/GoldenSignals. Pure +
 * injectable: inventory comes from injected fetchers (kubectl/aws/az/docker
 * commands over SSH/local); normalization and health-derivation are pure.
 */

export interface K8sPod {
  name: string
  namespace: string
  node?: string
  phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown'
  restarts: number
  ready: boolean
  /** container CPU/mem usage when metrics are available. */
  cpuMillicores?: number
  memMiB?: number
  cpuLimitMillicores?: number
  memLimitMiB?: number
}

export interface K8sNode {
  name: string
  ready: boolean
  cpuCapacityCores?: number
  memCapacityMiB?: number
  conditions?: Record<string, string>
}

export interface K8sClusterHealth {
  context: string
  totalPods: number
  runningPods: number
  notReadyPods: number
  crashLoopPods: number
  totalRestarts: number
  nodesReady: number
  nodesTotal: number
  cpuUsagePercentOfLimit?: number
  memUsagePercentOfLimit?: number
}

export interface CloudInstance {
  id: string
  name?: string
  state: string
  type?: string
  region?: string
  /** cloud provider metric if available. */
  cpuPercent?: number
  statusOk?: boolean
}

export interface InfraMonitorDeps {
  now?: () => number
}

/** Pure: parse kubectl get pods -o wide-like rows (text) into K8sPod[].
 * Handles BOTH output shapes:
 *   - default:  NAME READY STATUS RESTARTS AGE            (no namespace column)
 *   - all-ns:   NAMESPACE NAME READY STATUS RESTARTS AGE  (kubectl get pods -A)
 * Detects the shape from the header line. */
export function parseKubectlPods(text: string): K8sPod[] {
  const out: K8sPod[] = []
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== '')
  // Detect the all-namespaces shape from the header (starts with NAMESPACE).
  const header = lines.find((l) => /^NAME(SPACE)?\s+/.test(l))
  const hasNamespaceCol = header !== undefined && /^NAMESPACE\s+/.test(header)
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]
    if (/^NAME(SPACE)?\s+/.test(l)) continue // header
    const parts = l.trim().split(/\s+/)
    // With a namespace column, we need at least 6 fields; without it, at least 5.
    const minFields = hasNamespaceCol ? 6 : 5
    if (parts.length < minFields) continue

    let namespace = 'default'
    let name: string
    let readyFrac: string
    let status: string
    let restartsStr: string
    if (hasNamespaceCol) {
      ;[namespace, name, readyFrac, status, restartsStr] = parts
    } else {
      ;[name, readyFrac, status, restartsStr] = parts
    }

    const [readyNum, readyDen] = (readyFrac ?? '0/1').split('/').map((x) => parseInt(x, 10))
    const restarts = parseInt((restartsStr ?? '0').replace(/\D.*$/, ''), 10) || 0
    const phase = (['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown'].includes(status) ? status : 'Unknown') as K8sPod['phase']
    out.push({
      name,
      namespace,
      phase,
      restarts,
      ready: readyNum === readyDen && readyDen > 0 && status === 'Running',
    })
  }
  return out
}

/** Pure: derive cluster health from pods + nodes. */
export function clusterHealth(context: string, pods: K8sPod[], nodes: K8sNode[]): K8sClusterHealth {
  const running = pods.filter((p) => p.phase === 'Running')
  const notReady = pods.filter((p) => !p.ready).length
  const crashLoop = pods.filter((p) => p.restarts >= 5 || (p.phase === 'Unknown' && p.restarts > 0)).length
  const totalRestarts = pods.reduce((s, p) => s + p.restarts, 0)
  const nodesReady = nodes.filter((n) => n.ready).length
  let cpuPct: number | undefined
  let memPct: number | undefined
  const withCpu = pods.filter((p) => typeof p.cpuMillicores === 'number' && typeof p.cpuLimitMillicores === 'number' && p.cpuLimitMillicores! > 0)
  if (withCpu.length > 0) {
    const used = withCpu.reduce((s, p) => s + (p.cpuMillicores ?? 0), 0)
    const limit = withCpu.reduce((s, p) => s + (p.cpuLimitMillicores ?? 0), 0)
    cpuPct = limit > 0 ? (used / limit) * 100 : undefined
  }
  const withMem = pods.filter((p) => typeof p.memMiB === 'number' && typeof p.memLimitMiB === 'number' && p.memLimitMiB! > 0)
  if (withMem.length > 0) {
    const used = withMem.reduce((s, p) => s + (p.memMiB ?? 0), 0)
    const limit = withMem.reduce((s, p) => s + (p.memLimitMiB ?? 0), 0)
    memPct = limit > 0 ? (used / limit) * 100 : undefined
  }
  return {
    context,
    totalPods: pods.length,
    runningPods: running.length,
    notReadyPods: notReady,
    crashLoopPods: crashLoop,
    totalRestarts,
    nodesReady,
    nodesTotal: nodes.length,
    ...(cpuPct !== undefined ? { cpuUsagePercentOfLimit: cpuPct } : {}),
    ...(memPct !== undefined ? { memUsagePercentOfLimit: memPct } : {}),
  }
}

/** Pure: is a pod "unhealthy" (needs attention)? */
export function podUnhealthy(p: K8sPod): boolean {
  return !p.ready || p.phase === 'Failed' || p.phase === 'Unknown' || p.restarts >= 5
}

export class InfraMonitor {
  private readonly clusters = new Map<string, K8sClusterHealth>()
  private readonly instances = new Map<string, CloudInstance>()

  constructor(_deps: InfraMonitorDeps = {}) {}

  /** Record a cluster health snapshot. */
  recordCluster(context: string, pods: K8sPod[], nodes: K8sNode[]): K8sClusterHealth {
    const h = clusterHealth(context, pods, nodes)
    this.clusters.set(context, h)
    return h
  }

  cluster(context: string): K8sClusterHealth | undefined {
    return this.clusters.get(context)
  }

  clusters_(): readonly K8sClusterHealth[] {
    return Array.from(this.clusters.values())
  }

  /** Unhealthy pods for a cluster (for alerting). */
  unhealthyPods(pods: K8sPod[]): K8sPod[] {
    return pods.filter(podUnhealthy)
  }

  /** Record a cloud instance state. */
  recordInstance(inst: CloudInstance): void {
    this.instances.set(inst.id, inst)
  }

  instance(id: string): CloudInstance | undefined {
    return this.instances.get(id)
  }

  /** Instances that are not healthy (stopped/failed). */
  unhealthyInstances(): CloudInstance[] {
    return Array.from(this.instances.values()).filter((i) => i.statusOk === false || /stopped|terminated|failed/i.test(i.state))
  }

  clear(): void {
    this.clusters.clear()
    this.instances.clear()
  }
}

export function newClusterContextId(name: string): string {
  return `k8s-${name}-${randomUUID().slice(0, 6)}`
}
