import { PrometheusRegistry, registryFromHostMetrics } from './prometheusExporter'
import { OtelExporter, buildOtlpMetricsPayload } from './otelExporter'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function eq(a: unknown, b: unknown, msg = '') { if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`) }
function ok(v: unknown, msg = '') { if (!v) throw new Error(msg || 'expected truthy') }
function includes(hay: string, needle: string, msg = '') { if (!hay.includes(needle)) throw new Error(`${msg} expected output to include ${JSON.stringify(needle)}\n---\n${hay}`) }

// ─── PrometheusRegistry basics ───
test('gauge renders with HELP/TYPE and value', () => {
  const r = new PrometheusRegistry()
  r.gauge('cpu_usage', 'CPU usage percent', 42.5)
  const out = r.render()
  includes(out, '# HELP rterm_cpu_usage CPU usage percent')
  includes(out, '# TYPE rterm_cpu_usage gauge')
  includes(out, 'rterm_cpu_usage 42.5')
})
test('applies prefix to metric name', () => {
  const r = new PrometheusRegistry({ prefix: 'app' })
  r.gauge('mem_usage_percent', 'mem', 10)
  includes(r.render(), 'app_mem_usage_percent 10')
})
test('empty prefix yields unprefixed name', () => {
  const r = new PrometheusRegistry({ prefix: '' })
  r.gauge('up', 'up', 1)
  includes(r.render(), '\nup 1')
})
test('labels are rendered sorted and escaped', () => {
  const r = new PrometheusRegistry()
  r.gauge('disk', 'disk', 80, { mount: '/var"log', host: 'web-01' })
  includes(r.render(), 'rterm_disk{host="web-01",mount="/var\\"log"} 80')
})
test('counter renders as counter type', () => {
  const r = new PrometheusRegistry()
  r.counter('requests_total', 'total req', 1234)
  includes(r.render(), '# TYPE rterm_requests_total counter')
  includes(r.render(), 'rterm_requests_total 1234')
})
test('set() registers multi-series metric', () => {
  const r = new PrometheusRegistry()
  r.set('mem', 'memory', 'gauge', [
    { labels: { host: 'a' }, value: 50 },
    { labels: { host: 'b' }, value: 60 },
  ])
  const out = r.render()
  includes(out, 'rterm_mem{host="a"} 50')
  includes(out, 'rterm_mem{host="b"} 60')
})
test('non-finite values are skipped (no NaN/Inf lines)', () => {
  const r = new PrometheusRegistry()
  r.set('bad', 'bad', 'gauge', [
    { value: NaN },
    { value: Infinity },
    { value: 7 },
  ])
  const out = r.render()
  includes(out, 'rterm_bad 7')
  ok(!/rterm_bad (NaN|Inf)/.test(out), 'must not emit NaN/Inf')
})
test('invalid metric name throws', () => {
  const r = new PrometheusRegistry()
  let threw = false
  try { r.set('!!!', 'x', 'gauge', [{ value: 1 }]) } catch { threw = true }
  ok(threw, 'invalid name must throw')
})
test('invalid label name throws', () => {
  const r = new PrometheusRegistry()
  let threw = false
  try { r.gauge('x', 'x', 1, { 'bad-label': 'v' }) ; r.render() } catch { threw = true }
  ok(threw, 'invalid label must throw on render')
})
test('missing help text throws', () => {
  const r = new PrometheusRegistry()
  let threw = false
  try { r.set('x', '', 'gauge', [{ value: 1 }]) } catch { threw = true }
  ok(threw)
})
test('has/remove/size lifecycle', () => {
  const r = new PrometheusRegistry()
  r.gauge('a', 'a', 1)
  ok(r.has('a'))
  eq(r.size(), 1)
  ok(r.remove('a'))
  ok(!r.has('a'))
  eq(r.size(), 0)
})
test('list() returns sorted snapshot that is a copy (mutating it is safe)', () => {
  const r = new PrometheusRegistry()
  r.gauge('b', 'b', 2)
  r.gauge('a', 'a', 1)
  const l = r.list()
  eq(l[0].name, 'rterm_a')
  eq(l[1].name, 'rterm_b')
  l[0].samples[0].value = 999
  includes(r.render(), 'rterm_a 1') // unchanged
})
test('metrics render sorted by name', () => {
  const r = new PrometheusRegistry()
  r.gauge('zeta', 'z', 1)
  r.gauge('alpha', 'a', 2)
  const out = r.render()
  ok(out.indexOf('rterm_alpha') < out.indexOf('rterm_zeta'), 'sorted')
})
test('empty registry renders empty string', () => {
  eq(new PrometheusRegistry().render(), '')
})

// ─── registryFromHostMetrics ───
test('registryFromHostMetrics builds per-host gauges', () => {
  const r = registryFromHostMetrics([
    { host: 'web-01', metric: 'cpu', value: 70 },
    { host: 'web-02', metric: 'cpu', value: 30 },
    { host: 'web-01', metric: 'mem', value: 55 },
  ])
  const out = r.render()
  includes(out, 'rterm_cpu{host="web-01"} 70')
  includes(out, 'rterm_cpu{host="web-02"} 30')
  includes(out, 'rterm_mem{host="web-01"} 55')
})
test('registryFromHostMetrics skips non-finite values', () => {
  const r = registryFromHostMetrics([{ host: 'h', metric: 'm', value: NaN }])
  eq(r.size(), 0)
})

// ─── OTel payload building ───
test('buildOtlpMetricsPayload: gauge → gauge dataPoints with attrs + nano time', () => {
  const r = new PrometheusRegistry()
  r.gauge('cpu', 'cpu', 42, { host: 'h1' })
  const p = buildOtlpMetricsPayload(r, { 'service.name': 'rterm' }, 1000)
  const m = p.resourceMetrics[0].scopeMetrics[0].metrics[0]
  eq(m.name, 'rterm_cpu')
  ok(m.gauge, 'should be gauge')
  eq(m.gauge!.dataPoints[0].asDouble, 42)
  // 1000 ms → 1000 * 1e6 ns = 1e12 ns
  eq(m.gauge!.dataPoints[0].timeUnixNano, String(1000n * 1_000_000n))
  eq(m.gauge!.dataPoints[0].attributes![0].key, 'host')
  eq(m.gauge!.dataPoints[0].attributes![0].value.stringValue, 'h1')
})
test('buildOtlpMetricsPayload: counter → monotonic cumulative sum', () => {
  const r = new PrometheusRegistry()
  r.counter('req_total', 'req', 5)
  const p = buildOtlpMetricsPayload(r, {}, 0)
  const m = p.resourceMetrics[0].scopeMetrics[0].metrics[0]
  ok(m.sum, 'should be sum')
  eq(m.sum!.isMonotonic, true)
  eq(m.sum!.aggregationTemporality, 2)
})
test('buildOtlpMetricsPayload: resource attributes are set + sorted', () => {
  const r = new PrometheusRegistry()
  const p = buildOtlpMetricsPayload(r, { 'service.name': 'rterm', 'host.name': 'h' }, 0)
  const attrs = p.resourceMetrics[0].resource.attributes
  eq(attrs[0].key, 'host.name')
  eq(attrs[1].key, 'service.name')
})
test('buildOtlpMetricsPayload: skips metrics with no finite data points', () => {
  const r = new PrometheusRegistry()
  r.set('bad', 'bad', 'gauge', [{ value: NaN }])
  const p = buildOtlpMetricsPayload(r, {}, 0)
  eq(p.resourceMetrics[0].scopeMetrics[0].metrics.length, 0)
})

// ─── OtelExporter ───
test('OtelExporter pushes payload to endpoint via injected sender', async () => {
  const r = new PrometheusRegistry()
  r.gauge('up', 'up', 1)
  let seen: { endpoint: string; body: any } | null = null
  const ex = new OtelExporter({
    endpoint: 'http://collector:4318/v1/metrics',
    send: async (endpoint, body) => { seen = { endpoint, body }; return { ok: true, status: 200 } },
  })
  const res = await ex.push(r)
  ok(res.ok && res.status === 200)
  eq(seen!.endpoint, 'http://collector:4318/v1/metrics')
  ok(seen!.body.resourceMetrics, 'payload present')
})
test('OtelExporter records last() result', async () => {
  const ex = new OtelExporter({
    endpoint: 'http://x/v1/metrics',
    now: () => 500,
    send: async () => ({ ok: false, status: 503 }),
  })
  eq(ex.last(), null)
  await ex.push(new PrometheusRegistry())
  const l = ex.last()!
  eq(l.ok, false)
  eq(l.status, 503)
  eq(l.at, 500)
})
test('OtelExporter requires an endpoint', () => {
  let threw = false
  try { new OtelExporter({ endpoint: '' }) } catch { threw = true }
  ok(threw)
})
test('OtelExporter defaults service.name resource attr', async () => {
  let body: any = null
  const ex = new OtelExporter({ endpoint: 'http://x', send: async (_e, b) => { body = b; return { ok: true, status: 200 } } })
  await ex.push(new PrometheusRegistry())
  const keys = body.resourceMetrics[0].resource.attributes.map((a: any) => a.key)
  ok(keys.includes('service.name'), 'service.name default present')
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
