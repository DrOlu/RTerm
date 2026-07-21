import { parseKubectlPods } from '../infra/infraMonitor'
import { EarlyWarningService } from '../predictive/earlyWarningService'
import { AnomalyDetector } from '../predictive/anomalyDetector'
import { MetricsLedger } from '../sre/metricsLedger'
import type { ResourceSnapshot } from '../../types'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
let T = 1_000_000
const now = () => T
const DAY = 86_400_000

function snap(at: number, cpu = 50, disk = 50): ResourceSnapshot {
  return {
    timestamp: at, terminalId: 'h',
    cpu: { usagePercent: cpu },
    memory: { totalBytes: 1e9, usedBytes: 5e8, availableBytes: 5e8, usagePercent: 50 },
    disks: [{ filesystem: 'fs', mountPoint: '/', totalBytes: 1e9, usedBytes: 5e8, availableBytes: 5e8, usagePercent: disk }],
    network: [{ interface: 'eth0', rxBytesPerSec: 100, txBytesPerSec: 100 }],
    uptimeSeconds: 100,
  } as unknown as ResourceSnapshot
}

// ---- Bug 1: parseKubectlPods broke on kubectl get pods -A (namespace column) ----
test('bug1: parseKubectlPods handles kubectl get pods -A (namespace column) correctly', () => {
  const text = 'NAMESPACE   NAME                          READY   STATUS    RESTARTS   AGE\n' +
    'prod        web-7d9f5                     1/1     Running   0          5d\n' +
    'prod        api-6c8f4                     0/1     Pending   3          2d\n' +
    'kube-system coredns-5b7a2                 1/1     Running   12         30d\n'
  const pods = parseKubectlPods(text)
  if (pods.length !== 3) throw new Error(`expected 3 pods, got ${pods.length}`)
  if (pods[0].name !== 'web-7d9f5') throw new Error(`name should be web-7d9f5, got ${pods[0].name} (namespace column was misparsed as name)`)
  if (pods[0].namespace !== 'prod') throw new Error(`namespace should be prod, got ${pods[0].namespace}`)
  if (pods[2].namespace !== 'kube-system') throw new Error(`namespace should be kube-system, got ${pods[2].namespace}`)
  if (!pods[0].ready) throw new Error('web should be ready')
})

test('bug1: parseKubectlPods still handles the default (no namespace) format', () => {
  const text = 'NAME                          READY   STATUS    RESTARTS   AGE\n' +
    'web-7d9f5                     1/1     Running   0          5d\n' +
    'api-6c8f4                     0/1     Pending   3          2d\n'
  const pods = parseKubectlPods(text)
  if (pods.length !== 2) throw new Error(`expected 2 pods, got ${pods.length}`)
  if (pods[0].name !== 'web-7d9f5') throw new Error('name')
  if (pods[0].namespace !== 'default') throw new Error(`namespace should default, got ${pods[0].namespace}`)
})

// ---- Bug 3: earlyWarningService double-fired warnings on repeated evaluation ----
test('bug3: earlyWarningService does not re-fire the same warning within the cooldown window', () => {
  const fired: string[] = []
  const l = new MetricsLedger({ now })
  for (let d = 0; d < 10; d += 1) l.record('h', snap(T + d * DAY, 50, 40 + d * 2)) // disk rising, crosses 95
  const svc = new EarlyWarningService({
    ledger: l, anomalyDetector: new AnomalyDetector(l), now,
    onWarning: (w) => fired.push(w.kind),
  })
  // first evaluation fires the forecast warning
  svc.evaluate('h', 'diskUsagePercentMax', { threshold: 95, warnDays: 20, includeAnomalies: false })
  const firstCount = fired.length
  // second identical evaluation should NOT re-fire (cooldown)
  svc.evaluate('h', 'diskUsagePercentMax', { threshold: 95, warnDays: 20, includeAnomalies: false })
  if (fired.length !== firstCount) throw new Error(`warning re-fired within cooldown: ${firstCount} -> ${fired.length}`)
  // evaluateAll should also not storm: same host+metric+kind deduped
  svc.evaluateAll(['diskUsagePercentMax'], { threshold: 95, warnDays: 20, includeAnomalies: false })
  if (fired.length !== firstCount) throw new Error(`evaluateAll re-fired within cooldown: ${firstCount} -> ${fired.length}`)
})

test('bug3: earlyWarningService still returns warnings (even in cooldown) for the caller', () => {
  const l = new MetricsLedger({ now })
  for (let d = 0; d < 10; d += 1) l.record('h', snap(T + d * DAY, 50, 40 + d * 2))
  const svc = new EarlyWarningService({ ledger: l, anomalyDetector: new AnomalyDetector(l), now, onWarning: () => {} })
  const w1 = svc.evaluate('h', 'diskUsagePercentMax', { threshold: 95, warnDays: 20, includeAnomalies: false })
  const w2 = svc.evaluate('h', 'diskUsagePercentMax', { threshold: 95, warnDays: 20, includeAnomalies: false })
  if (w1.length !== 1 || w2.length !== 1) throw new Error('should return the warning even when cooldown suppresses the callback')
})

async function main() {
  let pass = 0, fail = 0
  for (const c of cases) {
    try { await c.run(); pass++; console.log(`PASS ${c.name}`) }
    catch (e: any) { fail++; console.log(`FAIL ${c.name}: ${e?.message ?? e}`) }
  }
  console.log(`\n${pass}/${cases.length} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
void main()
