import { NatsEventBus, resolveNatsOptions, type TermDataEvent, type MonitorSnapshotEvent } from './natsEventBus'
import type { NatsConnection, Subscription, Msg } from '@nats-io/transport-node'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

// ---- Fake NATS connection (in-memory pub/sub) ----
function fakeConnection() {
  const published: Array<{ subject: string; data: Uint8Array }> = []
  const listeners = new Map<string, Array<(msg: { data: Uint8Array }) => void>>()
  const conn = {
    isClosed: () => false,
    publish(subject: string, payload?: Uint8Array) {
      if (payload) published.push({ subject, data: payload })
      for (const fn of listeners.get(subject) ?? []) fn({ data: payload! })
    },
    subscribe(subject: string): Subscription {
      const sub = {
        async *[Symbol.asyncIterator]() {
          // wait for messages pushed via conn.publish
          while (true) {
            const m = await new Promise<{ data: Uint8Array }>((resolve) => {
              const list = listeners.get(subject) ?? []
              listeners.set(subject, list)
              list.push(resolve)
            })
            yield m as unknown as Msg
          }
        },
        unsubscribe: () => { listeners.delete(subject) },
      } as unknown as Subscription
      return sub
    },
    drain: async () => {},
  } as unknown as NatsConnection
  return { conn: conn as NatsConnection, published, listeners }
}

async function mkBus(conn: NatsConnection, opts: Partial<ConstructorParameters<typeof NatsEventBus>[0]> = {}) {
  const bus = new NatsEventBus({ servers: 'nats://fake:4222', connectFn: async () => conn, ...opts })
  await bus.connect()
  return bus
}

test('connect is idempotent and reports connected', async () => {
  const { conn } = fakeConnection()
  const bus = await mkBus(conn)
  await bus.connect() // second call should be a no-op
  if (!bus.connected) throw new Error('bus should be connected')
})

test('publishTermData publishes JSON to <prefix>.term.data', async () => {
  const { conn, published } = fakeConnection()
  const bus = await mkBus(conn)
  bus.publishTermData({ host: 'web-1', data: 'hello ERROR' })
  if (published.length !== 1) throw new Error('expected 1 publish')
  if (published[0].subject !== 'rterm.term.data') throw new Error(`wrong subject ${published[0].subject}`)
  const payload = JSON.parse(new TextDecoder().decode(published[0].data))
  if (payload.host !== 'web-1' || payload.data !== 'hello ERROR') throw new Error('wrong payload')
})

test('custom prefix is used for subjects', async () => {
  const { conn, published } = fakeConnection()
  const bus = await mkBus(conn, { prefix: 'fleet' })
  bus.publishMonitorSnapshot({ host: 'web-1', metrics: { cpu: 95 } })
  if (published[0].subject !== 'fleet.monitor.snapshot') throw new Error(published[0].subject)
})

test('onTermData invokes handler for each subscribed message', async () => {
  const { conn } = fakeConnection()
  const bus = await mkBus(conn)
  const got: TermDataEvent[] = []
  await bus.onTermData((ev) => got.push(ev))
  // simulate an inbound message from another instance
  conn.publish('rterm.term.data', new TextEncoder().encode(JSON.stringify({ host: 'web-2', data: 'down' })))
  await new Promise((r) => setTimeout(r, 20))
  if (got.length !== 1 || got[0].host !== 'web-2') throw new Error(`handler not called: ${JSON.stringify(got)}`)
})

test('onMonitorSnapshot invokes handler with metrics', async () => {
  const { conn } = fakeConnection()
  const bus = await mkBus(conn)
  const got: MonitorSnapshotEvent[] = []
  await bus.onMonitorSnapshot((ev) => got.push(ev))
  conn.publish('rterm.monitor.snapshot', new TextEncoder().encode(JSON.stringify({ host: 'web-1', metrics: { cpuUsagePercent: 97 } })))
  await new Promise((r) => setTimeout(r, 20))
  if (got.length !== 1 || got[0].metrics.cpuUsagePercent !== 97) throw new Error('snapshot handler not called')
})

test('publish before connect is a safe no-op', () => {
  const { conn } = fakeConnection()
  const bus = new NatsEventBus({ servers: 'nats://fake:4222', connectFn: async () => conn })
  bus.publishTermData({ host: 'x', data: 'y' }) // not connected yet
  if (bus.connected) throw new Error('should not be connected')
})

test('malformed inbound messages are ignored without crashing', async () => {
  const { conn } = fakeConnection()
  const bus = await mkBus(conn)
  const got: TermDataEvent[] = []
  await bus.onTermData((ev) => got.push(ev))
  conn.publish('rterm.term.data', new TextEncoder().encode('not-json{'))
  await new Promise((r) => setTimeout(r, 20))
  if (got.length !== 0) throw new Error('malformed should be ignored')
})

test('close drains and disconnects', async () => {
  const { conn } = fakeConnection()
  const bus = await mkBus(conn)
  await bus.close()
  if (bus.connected) throw new Error('should be disconnected after close')
})

test('resolveNatsOptions returns options when enabled with servers', () => {
  const o = resolveNatsOptions({ nats: { enabled: true, servers: ['nats://a:4222'] } })
  if (!o || !Array.isArray(o.servers)) throw new Error('should resolve servers')
})

test('resolveNatsOptions falls back to url', () => {
  const o = resolveNatsOptions({ nats: { enabled: true, url: 'nats://localhost:4222' } })
  if (!o || (o.servers as string[])[0] !== 'nats://localhost:4222') throw new Error('url fallback failed')
})

test('resolveNatsOptions returns null when disabled or no servers', () => {
  if (resolveNatsOptions({ nats: { enabled: false } }) !== null) throw new Error('disabled should be null')
  if (resolveNatsOptions({ nats: { enabled: true } }) !== null) throw new Error('no servers should be null')
  if (resolveNatsOptions({}) !== null) throw new Error('missing nats block should be null')
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
