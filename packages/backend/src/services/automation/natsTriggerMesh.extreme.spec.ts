import { createTriggerRuntime } from './triggerRuntime'
import { NatsEventBus, type TermDataEvent } from './natsEventBus'
import type { NatsConnection, Subscription, Msg } from '@nats-io/transport-node'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

/**
 * A shared in-memory NATS mesh: two connections fan out to each other so that
 * a publish on instance A is delivered to instance B's subscribers (and vice
 * versa). Proves the trigger-runtime NATS bridge actually bridges engines.
 */
function sharedMesh() {
  const all: Array<{ subject: string; data: Uint8Array }> = []
  // subject -> array of { owner, handler } subscribers (registered eagerly)
  const subs = new Map<string, Array<{ owner: string; handler: (m: { data: Uint8Array }) => void }>>()
  const mk = (owner: string): NatsConnection => ({
    isClosed: () => false,
    publish(subject: string, payload?: Uint8Array) {
      if (!payload) return
      all.push({ subject, data: payload })
      // deliver to every subscriber owned by a DIFFERENT instance
      for (const sub of subs.get(subject) ?? []) {
        if (sub.owner !== owner) sub.handler({ data: payload })
      }
    },
    subscribe(subject: string): Subscription {
      // a queue that the iterator drains; a resolver pushes into it
      const queue: Array<{ data: Uint8Array }> = []
      let waiter: ((m: { data: Uint8Array }) => void) | null = null
      const list = subs.get(subject) ?? []
      subs.set(subject, list)
      list.push({
        owner,
        handler: (m) => {
          if (waiter) { const w = waiter; waiter = null; w(m) }
          else queue.push(m)
        },
      })
      const sub = {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queue.length > 0) { yield queue.shift() as unknown as Msg; continue }
            const m = await new Promise<{ data: Uint8Array }>((resolve) => { waiter = resolve })
            yield m as unknown as Msg
          }
        },
        unsubscribe: () => subs.delete(subject),
      } as unknown as Subscription
      return sub
    },
    drain: async () => {},
  } as unknown as NatsConnection)
  return { mk, all }
}

async function mkRuntime(name: string, fired: string[], conn: NatsConnection, opts: { pattern?: string } = {}) {
  const am = {
    listTriggers: () => [{
      id: `t-${name}`, name: `err-${name}`, enabled: true, kind: 'pattern', action: 'run-playbook',
      playbookId: `pb-${name}`, match: opts.pattern ?? 'ERROR', createdAt: 1,
    }],
  } as any
  const ts = { setRawEventPublisher() {} } as any
  const bus = new NatsEventBus({ servers: 'nats://mesh:4222', connectFn: async () => conn })
  // Connect BEFORE creating the runtime so onTermData/onMonitorSnapshot register
  // (the bus no-ops subscriptions when not yet connected).
  await bus.connect()
  const runtime = createTriggerRuntime({
    automationManager: am,
    terminalService: ts,
    monitorService: null,
    natsBus: bus,
    runPlaybook: async (id: string) => { fired.push(`${name}:${id}`); return 'ok' },
    onLog: () => {},
  })
  return { runtime, bus }
}

test('mesh: a direct bus subscription on B receives A publish (sanity)', async () => {
  const mesh = sharedMesh()
  const busB = new NatsEventBus({ servers: 'x', connectFn: async () => mesh.mk('B') })
  await busB.connect()
  const got: TermDataEvent[] = []
  await busB.onTermData((ev) => got.push(ev))
  await new Promise((r) => setImmediate(r)) // let consume loop start
  const busA = new NatsEventBus({ servers: 'x', connectFn: async () => mesh.mk('A') })
  await busA.connect()
  busA.publishTermData({ host: 'host-A', data: 'ERROR ping' })
  await new Promise((r) => setTimeout(r, 40))
  if (got.length !== 1) throw new Error(`bus subscription got ${JSON.stringify(got)}`)
  if (!got[0].data.includes('ERROR')) throw new Error('wrong payload')
  await busA.close()
  await busB.close()
})

test('local terminal event on instance A fires instance B trigger via NATS mesh', async () => {
  const firedA: string[] = []
  const firedB: string[] = []
  const mesh = sharedMesh()
  const busA = await mkRuntime('A', firedA, mesh.mk('A'))
  const busB = await mkRuntime('B', firedB, mesh.mk('B'))
  // subscriptions are live (bus connected in mkRuntime; runtime awaited its subs)
  await (busB.runtime as any).busReady
  await (busA.runtime as any).busReady

  // Instance A sees local output containing ERROR -> publishes to mesh -> B's engine fires.
  busA.bus.publishTermData({ host: 'host-A', data: 'something ERROR happened' })
  await new Promise((r) => setTimeout(r, 40))

  if (!firedB.some((f) => f.startsWith('B:'))) {
    throw new Error(`expected instance B to fire, got firedB=${JSON.stringify(firedB)}`)
  }
  await busA.bus.close()
  await busB.bus.close()
})

test('instance-local triggers still fire on local events (no mesh echo of own publish needed)', async () => {
  const firedA: string[] = []
  const mesh = sharedMesh()
  const busA = await mkRuntime('A', firedA, mesh.mk('A'))
  // Feed A's own engine directly (simulating its local terminal feed).
  busA.runtime.handleTerminalData('host-A', 'ERROR local')
  await new Promise((r) => setTimeout(r, 20))
  if (!firedA.some((f) => f.startsWith('A:'))) throw new Error('local trigger did not fire')
  await busA.bus.close()
})

test('scoped triggers only fire for matching remote hosts', async () => {
  const firedB: string[] = []
  const mesh = sharedMesh()
  const connB = mesh.mk('B')
  const amB = {
    listTriggers: () => [{
      id: 'tB', name: 'scoped', enabled: true, kind: 'pattern', action: 'run-playbook',
      playbookId: 'pbB', match: 'ERROR', scopeHosts: ['only-this-host'], createdAt: 1,
    }],
  } as any
  const busB = new NatsEventBus({ servers: 'nats://mesh:4222', connectFn: async () => connB })
  await busB.connect()
  createTriggerRuntime({
    automationManager: amB, terminalService: { setRawEventPublisher() {} } as any,
    monitorService: null, natsBus: busB,
    runPlaybook: async (id: string) => { firedB.push(id); return 'ok' }, onLog: () => {},
  })
  // A remote event from a DIFFERENT host should NOT fire the scoped trigger.
  busB.publishTermData({ host: 'other-host', data: 'ERROR' })
  await new Promise((r) => setTimeout(r, 30))
  if (firedB.length !== 0) throw new Error(`out-of-scope remote event fired: ${JSON.stringify(firedB)}`)
  await busB.close()
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
