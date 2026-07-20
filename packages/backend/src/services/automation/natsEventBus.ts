import { connect, type NatsConnection, type Subscription } from '@nats-io/transport-node'

/**
 * NatsEventBus — a thin, injectable NATS transport adapter for RTerm's
 * event-driven automation.
 *
 * Turns the TriggerEngine's in-process event feeds into a distributed event
 * mesh: many rterm-backend instances publish terminal output + monitor
 * snapshots onto NATS subjects, and every instance's TriggerEngine consumes
 * them — so a pattern/threshold trigger can fire across the whole fleet, not
 * just the local host.
 *
 * Subjects (configurable prefix, default "rterm"):
 *   <prefix>.term.data        terminal output chunks { host, data }
 *   <prefix>.monitor.snapshot monitor snapshots { host, metrics }
 *   <prefix>.trigger.fire     manual webhook fires { triggerId?, reason }
 *
 * Design:
 *   - Pure + injectable: the connection is created lazily via `connect()`.
 *     Pass a custom `connectFn` in tests to fake NATS without a server.
 *   - Fire-and-forget publishes (NATS is at-most-once by default); the bus is
 *     best-effort and never blocks the automation path.
 *   - Payloads are JSON-encoded bytes (no codec dependency in v3 transport).
 */

export interface NatsBusOptions {
  /** NATS server url(s), e.g. "nats://localhost:4222" or ["nats://a:4222","nats://b:4222"]. */
  servers: string | string[]
  /** subject prefix (default "rterm"). */
  prefix?: string
  /** optional client name for server-side identification. */
  name?: string
  /** connect override for tests (defaults to transport-node connect). */
  connectFn?: (opts: unknown) => Promise<NatsConnection>
  /** onLog callback. */
  onLog?: (line: string) => void
}

export interface TermDataEvent { host: string; data: string }
export interface MonitorSnapshotEvent { host: string; metrics: Record<string, unknown> }
export interface TriggerFireEvent { triggerId?: string; reason?: string }

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class NatsEventBus {
  private conn: NatsConnection | null = null
  private subs: Subscription[] = []
  private readonly prefix: string
  private readonly opts: NatsBusOptions

  constructor(opts: NatsBusOptions) {
    this.opts = opts
    this.prefix = opts.prefix ?? 'rterm'
  }

  private log(line: string): void {
    try { this.opts.onLog?.(line) } catch { /* best-effort */ }
  }

  get connected(): boolean {
    return this.conn !== null && !this.conn!.isClosed()
  }

  private subject(kind: 'term.data' | 'monitor.snapshot' | 'trigger.fire'): string {
    return `${this.prefix}.${kind}`
  }

  /** Connect to NATS (idempotent). */
  async connect(): Promise<void> {
    if (this.conn) return
    const connectFn = this.opts.connectFn ?? ((o: unknown) => connect(o as Parameters<typeof connect>[0]))
    this.conn = await connectFn({
      servers: this.opts.servers,
      name: this.opts.name ?? 'rterm-backend',
    })
    this.log(`[nats] connected to ${Array.isArray(this.opts.servers) ? this.opts.servers.join(',') : this.opts.servers}`)
  }

  /** Publish a terminal-output chunk. */
  publishTermData(ev: TermDataEvent): void {
    if (!this.conn) return
    try {
      this.conn.publish(this.subject('term.data'), encoder.encode(JSON.stringify(ev)))
    } catch { /* best-effort */ }
  }

  /** Publish a monitor snapshot. */
  publishMonitorSnapshot(ev: MonitorSnapshotEvent): void {
    if (!this.conn) return
    try {
      this.conn.publish(this.subject('monitor.snapshot'), encoder.encode(JSON.stringify(ev)))
    } catch { /* best-effort */ }
  }

  /** Publish a manual webhook fire. */
  publishTriggerFire(ev: TriggerFireEvent): void {
    if (!this.conn) return
    try {
      this.conn.publish(this.subject('trigger.fire'), encoder.encode(JSON.stringify(ev)))
    } catch { /* best-effort */ }
  }

  /** Subscribe to terminal-output events. The subscription is live immediately
   * (matching the real @nats-io subscribe() semantics), so a publish that lands
   * right after this call is delivered — no reliance on the iterator starting. */
  async onTermData(handler: (ev: TermDataEvent) => void): Promise<void> {
    if (!this.conn) return
    const sub = this.conn.subscribe(this.subject('term.data'))
    this.subs.push(sub)
    this.consume(sub, (data) => {
      try { handler(JSON.parse(decoder.decode(data)) as TermDataEvent) } catch { /* ignore malformed */ }
    })
  }

  /** Subscribe to monitor-snapshot events (live immediately). */
  async onMonitorSnapshot(handler: (ev: MonitorSnapshotEvent) => void): Promise<void> {
    if (!this.conn) return
    const sub = this.conn.subscribe(this.subject('monitor.snapshot'))
    this.subs.push(sub)
    this.consume(sub, (data) => {
      try { handler(JSON.parse(decoder.decode(data)) as MonitorSnapshotEvent) } catch { /* ignore malformed */ }
    })
  }

  /** Subscribe to manual webhook fires (live immediately). */
  async onTriggerFire(handler: (ev: TriggerFireEvent) => void): Promise<void> {
    if (!this.conn) return
    const sub = this.conn.subscribe(this.subject('trigger.fire'))
    this.subs.push(sub)
    this.consume(sub, (data) => {
      try { handler(JSON.parse(decoder.decode(data)) as TriggerFireEvent) } catch { /* ignore malformed */ }
    })
  }

  /** Eagerly start consuming a subscription: the async-iterator is driven in the
   * background immediately, so the subscription is consuming before this method
   * returns control to the event loop. */
  private consume(sub: Subscription, onData: (data: Uint8Array) => void): void {
    const loop = (async () => {
      for await (const msg of sub) {
        try { onData(msg.data) } catch { /* best-effort */ }
      }
    })()
    // Swallow normal close/unsubscribe rejections.
    loop.catch(() => {})
  }

  /** Drain subscriptions and close the connection. */
  async close(): Promise<void> {
    for (const sub of this.subs) {
      try { sub.unsubscribe() } catch { /* best-effort */ }
    }
    this.subs = []
    if (this.conn) {
      try { await this.conn.drain() } catch { /* best-effort */ }
      this.conn = null
    }
  }
}

/** Parse NATS settings from the settings object (settings.nats). Returns null
 * when disabled/unconfigured. */
export function resolveNatsOptions(settings: unknown): NatsBusOptions | null {
  const n = (settings as { nats?: { enabled?: boolean; url?: string; servers?: string[]; prefix?: string } } | undefined)?.nats
  if (!n || n.enabled === false) return null
  const servers = n.servers && n.servers.length > 0 ? n.servers : (n.url ? [n.url] : null)
  if (!servers) return null
  return { servers, ...(n.prefix ? { prefix: n.prefix } : {}) }
}
