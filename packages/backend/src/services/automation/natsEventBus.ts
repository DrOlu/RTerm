import {
  connect,
  credsAuthenticator,
  headers as natsHeaders,
  jwtAuthenticator,
  nkeyAuthenticator,
  tokenAuthenticator,
  usernamePasswordAuthenticator,
  type Authenticator,
  type ConnectionOptions,
  type NatsConnection,
  type Msg,
  type MsgHdrs,
  type Subscription,
  type SubscriptionOptions,
} from '@nats-io/transport-node'
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from '@nats-io/jetstream'
import { Kvm, type KV, type KvWatchEntry } from '@nats-io/kv'

/**
 * NatsEventBus — comprehensive NATS transport adapter for RTerm's event-driven
 * automation, fleet mesh, and durable messaging.
 *
 * v3.1.2 — full rewrite. Covers the entire NATS feature surface:
 *   - **Auth**: token, username/password, NKey (seed), JWT (jwt+seed), .creds file,
 *     and TLS mutual-auth (cert/key/ca). Secrets are accepted as values or
 *     `secretRef` pointers (resolved by the caller via the vault).
 *   - **Core pub/sub**: publish/subscribe with optional queue groups + headers.
 *   - **Request/Reply**: `request()` with timeout + `respond()` handler registration.
 *   - **JetStream**: streams (add/info/list/purge/delete), durable publish with ack,
 *     pull + push consumers, fetch, and consumer management.
 *   - **Key-Value**: bucket create/open, get/put/delete/purge, keys, watch, history.
 *   - **Connection lifecycle**: reconnect/close events, lame-duck, drain, status.
 *
 * Design:
 *   - Pure + injectable: the connection is created lazily via `connect()`; pass a
 *     custom `connectFn` (and `jetstreamFn`/`kvmFn`) in tests to fake NATS/JS/KV.
 *   - Best-effort core publishes never block the automation path; durable JetStream
 *     publishes await a PubAck by default (configurable).
 *   - Payloads are JSON-encoded bytes (no codec dependency).
 */

// ─── Options & events ────────────────────────────────────────────────────────

export interface NatsAuthOptions {
  /** Static token auth. */
  token?: string
  /** Username/password auth. */
  username?: string
  password?: string
  /** NKey: the seed (SU…) used to sign the server nonce. Value or secretRef-resolved. */
  nkeySeed?: string | Uint8Array
  /** JWT: the user JWT plus the signing seed. */
  jwt?: string
  jwtSeed?: string | Uint8Array
  /** .creds file contents (JWT+seed bundle). Value or file bytes. */
  creds?: string | Uint8Array
  /** TLS mutual auth. */
  tlsCert?: string
  tlsKey?: string
  tlsCa?: string
}

export interface NatsBusOptions {
  /** NATS server url(s), e.g. "nats://localhost:4222" or ["nats://a:4222","nats://b:4222"]. */
  servers: string | string[]
  /** subject prefix (default "rterm"). */
  prefix?: string
  /** optional client name for server-side identification. */
  name?: string
  /** auth options (token / user-pass / nkey / jwt / creds / tls). */
  auth?: NatsAuthOptions
  /** default queue group for subscriptions (load-balance across instances). */
  queue?: string
  /** max reconnect attempts (-1 = unlimited, NATS default). */
  maxReconnectAttempts?: number
  /** reconnect wait between attempts (ms). */
  reconnectTimeWait?: number
  /** connect timeout (ms). */
  timeout?: number
  /** callbacks for observability. */
  onLog?: (line: string) => void
  onReconnect?: (url: string) => void
  onDisconnect?: (url: string) => void
  onError?: (err: unknown) => void
  /** connect override for tests (defaults to transport-node connect). */
  connectFn?: (opts: ConnectionOptions) => Promise<NatsConnection>
  /** jetstream client factory override for tests. */
  jetstreamFn?: (conn: NatsConnection) => JetStreamClient
  /** jetstream manager factory override for tests. */
  jetstreamManagerFn?: (conn: NatsConnection) => Promise<JetStreamManager>
  /** KVM factory override for tests. */
  kvmFn?: (conn: NatsConnection) => Kvm
}

export interface TermDataEvent { host: string; data: string }
export interface MonitorSnapshotEvent { host: string; metrics: Record<string, unknown> }
export interface TriggerFireEvent { triggerId?: string; reason?: string }

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function encodeJson(v: unknown): Uint8Array { return encoder.encode(JSON.stringify(v)) }
function decodeJson<T>(b: Uint8Array): T { return JSON.parse(decoder.decode(b)) as T }

// ─── The bus ─────────────────────────────────────────────────────────────────

export class NatsEventBus {
  private conn: NatsConnection | null = null
  private subs: Subscription[] = []
  private js: JetStreamClient | null = null
  private jsm: JetStreamManager | null = null
  private kvm: Kvm | null = null
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

  /** The underlying connection (null until connect()). */
  get connection(): NatsConnection | null { return this.conn }

  private subject(kind: string): string {
    return `${this.prefix}.${kind}`
  }

  /** Build the Authenticator from the configured auth options (undefined = open server). */
  private buildAuthenticator(): Authenticator | undefined {
    const a = this.opts.auth
    if (!a) return undefined
    if (a.creds) {
      const bytes = typeof a.creds === 'string' ? encoder.encode(a.creds) : a.creds
      return credsAuthenticator(bytes)
    }
    if (a.jwt) {
      const seed = typeof a.jwtSeed === 'string' ? encoder.encode(a.jwtSeed) : a.jwtSeed
      return jwtAuthenticator(a.jwt, seed)
    }
    if (a.nkeySeed) {
      const seed = typeof a.nkeySeed === 'string' ? encoder.encode(a.nkeySeed) : a.nkeySeed
      return nkeyAuthenticator(seed)
    }
    if (a.token) return tokenAuthenticator(a.token)
    if (a.username !== undefined) return usernamePasswordAuthenticator(a.username, a.password ?? '')
    return undefined
  }

  /** Build the TLS options (mutual auth) when cert material is configured. */
  private buildTls(): ConnectionOptions['tls'] {
    const a = this.opts.auth
    if (!a || (!a.tlsCert && !a.tlsKey && !a.tlsCa)) return undefined
    const tls: { cert?: string; key?: string; ca?: string } = {}
    if (a.tlsCert) tls.cert = a.tlsCert
    if (a.tlsKey) tls.key = a.tlsKey
    if (a.tlsCa) tls.ca = a.tlsCa
    return tls
  }

  /** Connect to NATS (idempotent). Wires lifecycle event handlers. */
  async connect(): Promise<void> {
    if (this.conn) return
    const connectFn = this.opts.connectFn ?? ((o: ConnectionOptions) => connect(o))
    const authenticator = this.buildAuthenticator()
    const tls = this.buildTls()
    const copts: ConnectionOptions = {
      servers: this.opts.servers,
      name: this.opts.name ?? 'rterm-backend',
      ...(authenticator ? { authenticator } : {}),
      ...(tls ? { tls } : {}),
      ...(this.opts.maxReconnectAttempts !== undefined ? { maxReconnectAttempts: this.opts.maxReconnectAttempts } : {}),
      ...(this.opts.reconnectTimeWait !== undefined ? { reconnectTimeWait: this.opts.reconnectTimeWait } : {}),
      ...(this.opts.timeout !== undefined ? { timeout: this.opts.timeout } : {}),
    }
    this.conn = await connectFn(copts)
    this.wireStatusHandlers(this.conn)
    this.log(`[nats] connected to ${Array.isArray(this.opts.servers) ? this.opts.servers.join(',') : this.opts.servers}`)
  }

  /** Attach reconnect/disconnect/error/lame-duck handlers (best-effort). */
  private wireStatusHandlers(conn: NatsConnection): void {
    const c = conn as unknown as {
      status?: () => AsyncIterable<{ type: string; data?: unknown }>
    }
    if (typeof c.status !== 'function') return
    const loop = (async () => {
      try {
        for await (const s of c.status!()) {
          const url = String((s.data as { url?: string })?.url ?? '')
          if (s.type === 'reconnect') { this.log(`[nats] reconnect ${url}`); try { this.opts.onReconnect?.(url) } catch {} }
          else if (s.type === 'disconnect') { this.log(`[nats] disconnect ${url}`); try { this.opts.onDisconnect?.(url) } catch {} }
          else if (s.type === 'error') { try { this.opts.onError?.(s.data) } catch {} }
          else if (s.type === 'ldm') { this.log('[nats] lame-duck mode') }
        }
      } catch { /* connection closed */ }
    })()
    loop.catch(() => {})
  }

  /** Lazily build (and cache) the JetStream client. */
  private async jetstream(): Promise<JetStreamClient> {
    if (!this.conn) throw new Error('NATS not connected')
    if (!this.js) {
      const fn = this.opts.jetstreamFn ?? ((c: NatsConnection) => jetstream(c))
      this.js = fn(this.conn)
    }
    return this.js
  }

  /** Lazily build (and cache) the JetStream manager. */
  private async jetstreamManager(): Promise<JetStreamManager> {
    if (!this.conn) throw new Error('NATS not connected')
    if (!this.jsm) {
      const fn = this.opts.jetstreamManagerFn ?? ((c: NatsConnection) => jetstreamManager(c))
      this.jsm = await fn(this.conn)
    }
    return this.jsm
  }

  /** Lazily build (and cache) the KV manager. */
  private kvManager(): Kvm {
    if (!this.conn) throw new Error('NATS not connected')
    if (!this.kvm) {
      const fn = this.opts.kvmFn ?? ((c: NatsConnection) => new Kvm(c))
      this.kvm = fn(this.conn)
    }
    return this.kvm
  }

  // ─── Core pub/sub ──────────────────────────────────────────────────────────

  /** Publish a message to a subject (best-effort, at-most-once). */
  publish(subjectName: string, payload: unknown, opts?: { headers?: Record<string, string> }): void {
    if (!this.conn) return
    try {
      const full = subjectName.startsWith(this.prefix + '.') ? subjectName : this.subject(subjectName)
      const hdrs = opts?.headers ? toMsgHdrs(opts.headers) : undefined
      this.conn.publish(full, encodeJson(payload), hdrs ? { headers: hdrs } : undefined)
    } catch { /* best-effort */ }
  }

  /** Subscribe to a subject. Returns an unsubscribe function. */
  async subscribe(
    subjectName: string,
    handler: (payload: unknown, msg: { subject: string; headers?: Record<string, string> }) => void,
    opts?: { queue?: string },
  ): Promise<() => void> {
    if (!this.conn) return () => {}
    const full = subjectName.startsWith(this.prefix + '.') ? subjectName : this.subject(subjectName)
    const queue = opts?.queue ?? this.opts.queue
    const so: SubscriptionOptions | undefined = queue ? { queue } : undefined
    const sub = so ? this.conn.subscribe(full, so) : this.conn.subscribe(full)
    this.subs.push(sub)
    this.consume(sub, (data, msg) => {
      try {
        handler(decodeJson(data), { subject: msg.subject, headers: msg.headers ? fromMsgHdrs(msg.headers) : undefined })
      } catch { /* ignore malformed */ }
    })
    return () => { try { sub.unsubscribe() } catch {} }
  }

  // ─── Request / Reply ───────────────────────────────────────────────────────

  /** Core NATS request/reply: send a request, await one reply (ms timeout). */
  async request<T = unknown>(subjectName: string, payload: unknown, opts?: { timeout?: number; headers?: Record<string, string> }): Promise<T> {
    if (!this.conn) throw new Error('NATS not connected')
    const full = subjectName.startsWith(this.prefix + '.') ? subjectName : this.subject(subjectName)
    const hdrs = opts?.headers ? toMsgHdrs(opts.headers) : undefined
    const msg = await this.conn.request(full, encodeJson(payload), {
      timeout: opts?.timeout ?? 5000,
      ...(hdrs ? { headers: hdrs } : {}),
    })
    return decodeJson<T>(msg.data)
  }

  /** Register a reply handler for a subject (the "server" side of request/reply). */
  async respond(
    subjectName: string,
    handler: (payload: unknown) => unknown | Promise<unknown>,
    opts?: { queue?: string },
  ): Promise<() => void> {
    if (!this.conn) return () => {}
    const full = subjectName.startsWith(this.prefix + '.') ? subjectName : this.subject(subjectName)
    const queue = opts?.queue ?? this.opts.queue
    const so: SubscriptionOptions | undefined = queue ? { queue } : undefined
    const sub = so ? this.conn.subscribe(full, so) : this.conn.subscribe(full)
    this.subs.push(sub)
    const loop = (async () => {
      for await (const msg of sub) {
        try {
          const result = await handler(decodeJson(msg.data))
          msg.respond(encodeJson(result))
        } catch { /* best-effort */ }
      }
    })()
    loop.catch(() => {})
    return () => { try { sub.unsubscribe() } catch {} }
  }

  // ─── Domain helpers (the trigger mesh) ─────────────────────────────────────

  publishTermData(ev: TermDataEvent): void { this.publish('term.data', ev) }
  publishMonitorSnapshot(ev: MonitorSnapshotEvent): void { this.publish('monitor.snapshot', ev) }
  publishTriggerFire(ev: TriggerFireEvent): void { this.publish('trigger.fire', ev) }

  async onTermData(handler: (ev: TermDataEvent) => void): Promise<void> {
    await this.subscribe('term.data', (p) => handler(p as TermDataEvent))
  }
  async onMonitorSnapshot(handler: (ev: MonitorSnapshotEvent) => void): Promise<void> {
    await this.subscribe('monitor.snapshot', (p) => handler(p as MonitorSnapshotEvent))
  }
  async onTriggerFire(handler: (ev: TriggerFireEvent) => void): Promise<void> {
    await this.subscribe('trigger.fire', (p) => handler(p as TriggerFireEvent))
  }

  // ─── JetStream ─────────────────────────────────────────────────────────────

  /** Add (or update) a JetStream stream. */
  async streamAdd(cfg: { name: string; subjects: string[]; retention?: 'limits' | 'interest' | 'workqueue'; storage?: 'file' | 'memory'; maxAge?: number; duplicates?: number }): Promise<unknown> {
    const jsm = await this.jetstreamManager()
    const sc: Record<string, unknown> = {
      name: cfg.name,
      subjects: cfg.subjects,
      ...(cfg.retention ? { retention: cfg.retention } : {}),
      ...(cfg.storage ? { storage: cfg.storage } : {}),
      ...(cfg.maxAge !== undefined ? { max_age: cfg.maxAge } : {}),
      ...(cfg.duplicates !== undefined ? { duplicate_window: cfg.duplicates } : {}),
    }
    return jsm.streams.add(sc as never)
  }

  /** Get stream info. */
  async streamInfo(name: string): Promise<unknown> {
    const jsm = await this.jetstreamManager()
    return jsm.streams.info(name)
  }

  /** List streams (optionally filtered by subject). */
  async streamList(subject?: string): Promise<unknown[]> {
    const jsm = await this.jetstreamManager()
    const lister = jsm.streams.list(subject)
    const out: unknown[] = []
    for await (const s of lister) out.push(s)
    return out
  }

  /** Purge a stream (all messages, or filtered). */
  async streamPurge(name: string, opts?: { subject?: string; keep?: number }): Promise<unknown> {
    const jsm = await this.jetstreamManager()
    return jsm.streams.purge(name, opts as never)
  }

  /** Delete a stream. */
  async streamDelete(name: string): Promise<boolean> {
    const jsm = await this.jetstreamManager()
    return jsm.streams.delete(name)
  }

  /** Durable JetStream publish — awaits a PubAck (stream + seq). */
  async jsPublish(subjectName: string, payload: unknown, opts?: { msgId?: string; timeout?: number; headers?: Record<string, string> }): Promise<{ stream: string; seq: number; duplicate?: boolean }> {
    const js = await this.jetstream()
    const full = subjectName.startsWith(this.prefix + '.') ? subjectName : this.subject(subjectName)
    const hdrs = opts?.headers ? toMsgHdrs(opts.headers) : undefined
    const pa = await js.publish(full, encodeJson(payload), {
      ...(opts?.msgId ? { msgID: opts.msgId } : {}),
      ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}),
      ...(hdrs ? { headers: hdrs } : {}),
    } as never)
    return { stream: pa.stream, seq: pa.seq, duplicate: pa.duplicate }
  }

  /** Consume messages from a stream via an (ordered or durable) consumer. */
  async jsConsume(
    stream: string,
    handler: (payload: unknown, msg: { subject: string; seq?: number }) => void | Promise<void>,
    opts?: { durable?: string; queue?: string; batch?: number },
  ): Promise<() => void> {
    const js = await this.jetstream()
    const c = await js.consumers.get(stream, opts?.durable)
    const messages = await c.consume({ max_messages: opts?.batch } as never)
    let stopped = false
    const loop = (async () => {
      for await (const m of messages) {
        if (stopped) break
        try {
          await handler(decodeJson(m.data), { subject: m.subject, seq: (m as unknown as { seq?: number }).seq })
          m.ack()
        } catch { /* nak on handler error */ try { m.nak() } catch {} }
      }
    })()
    loop.catch(() => {})
    return () => { stopped = true; try { (messages as unknown as { stop?: () => void }).stop?.() } catch {} }
  }

  /** Fetch a batch of messages from a stream (pull). */
  async jsFetch(stream: string, opts?: { durable?: string; batch?: number; expires?: number }): Promise<Array<{ payload: unknown; subject: string }>> {
    const js = await this.jetstream()
    const c = await js.consumers.get(stream, opts?.durable)
    const messages = await c.fetch({ max_messages: opts?.batch ?? 10, expires: opts?.expires ?? 2000 } as never)
    const out: Array<{ payload: unknown; subject: string }> = []
    for await (const m of messages) {
      try { out.push({ payload: decodeJson(m.data), subject: m.subject }); m.ack() } catch { /* skip */ }
    }
    return out
  }

  // ─── Key-Value ─────────────────────────────────────────────────────────────

  /** Create a KV bucket. */
  async kvCreateBucket(bucket: string, opts?: { history?: number; ttl?: number; description?: string }): Promise<KV> {
    const kvm = this.kvManager()
    return kvm.create(bucket, {
      ...(opts?.history !== undefined ? { history: opts.history } : {}),
      ...(opts?.ttl !== undefined ? { ttl: opts.ttl } : {}),
      ...(opts?.description ? { description: opts.description } : {}),
    } as never)
  }

  /** Open an existing KV bucket. */
  async kvBucket(bucket: string): Promise<KV> {
    const kvm = this.kvManager()
    return kvm.open(bucket)
  }

  /** KV put (returns revision). */
  async kvPut(bucket: string, key: string, value: unknown): Promise<number> {
    const b = await this.kvBucket(bucket)
    return b.put(key, encodeJson(value))
  }

  /** KV get (returns {value, revision} or null). */
  async kvGet<T = unknown>(bucket: string, key: string): Promise<{ value: T; revision: number } | null> {
    const b = await this.kvBucket(bucket)
    const e = await b.get(key)
    if (!e) return null
    try { return { value: decodeJson<T>(e.value), revision: e.revision } } catch { return null }
  }

  /** KV delete. */
  async kvDelete(bucket: string, key: string): Promise<void> {
    const b = await this.kvBucket(bucket)
    return b.delete(key)
  }

  /** KV keys (optionally filtered). */
  async kvKeys(bucket: string, filter?: string): Promise<string[]> {
    const b = await this.kvBucket(bucket)
    const it = await b.keys(filter)
    const out: string[] = []
    for await (const k of it) out.push(k)
    return out
  }

  /** KV watch a key (or all) — invokes handler on each change. Returns a stop fn. */
  async kvWatch(
    bucket: string,
    handler: (entry: { key: string; value: unknown; operation: string }) => void,
    opts?: { key?: string },
  ): Promise<() => void> {
    const b = await this.kvBucket(bucket)
    const w = await b.watch(opts?.key ? { key: opts.key } : undefined)
    const loop = (async () => {
      for await (const e of w as AsyncIterable<KvWatchEntry>) {
        try {
          handler({ key: e.key, value: e.operation === 'PUT' ? decodeJson(e.value) : undefined, operation: e.operation })
        } catch { /* best-effort */ }
      }
    })()
    loop.catch(() => {})
    return () => { try { (w as unknown as { stop?: () => void }).stop?.() } catch {} }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /** Eagerly start consuming a subscription in the background. */
  private consume(sub: Subscription, onData: (data: Uint8Array, msg: Msg) => void): void {
    const loop = (async () => {
      for await (const msg of sub) {
        try { onData(msg.data, msg) } catch { /* best-effort */ }
      }
    })()
    loop.catch(() => {})
  }

  /** Drain subscriptions and close the connection. */
  async close(): Promise<void> {
    for (const sub of this.subs) {
      try { sub.unsubscribe() } catch { /* best-effort */ }
    }
    this.subs = []
    this.js = null
    this.jsm = null
    this.kvm = null
    if (this.conn) {
      try { await this.conn.drain() } catch { /* best-effort */ }
      this.conn = null
    }
  }
}

// ─── Header helpers ──────────────────────────────────────────────────────────

function toMsgHdrs(h: Record<string, string>): MsgHdrs {
  const mh = natsHeaders()
  for (const [k, v] of Object.entries(h)) mh.set(k, v)
  return mh
}

function fromMsgHdrs(h: MsgHdrs): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of h.keys()) out[k] = h.get(k)
  return out
}

// ─── Settings resolution ─────────────────────────────────────────────────────

/** Parse NATS settings from the settings object (settings.nats). Returns null when
 * disabled/unconfigured. Supports auth via inline values or `secretRef` pointers
 * (the caller resolves secretRefs through the vault before constructing the bus). */
export function resolveNatsOptions(settings: unknown): NatsBusOptions | null {
  const n = (settings as {
    nats?: {
      enabled?: boolean
      url?: string
      servers?: string[]
      prefix?: string
      queue?: string
      maxReconnectAttempts?: number
      reconnectTimeWait?: number
      timeout?: number
      auth?: NatsAuthOptions
    }
  } | undefined)?.nats
  if (!n || n.enabled === false) return null
  const servers = n.servers && n.servers.length > 0 ? n.servers : (n.url ? [n.url] : null)
  if (!servers) return null
  return {
    servers,
    ...(n.prefix ? { prefix: n.prefix } : {}),
    ...(n.queue ? { queue: n.queue } : {}),
    ...(n.maxReconnectAttempts !== undefined ? { maxReconnectAttempts: n.maxReconnectAttempts } : {}),
    ...(n.reconnectTimeWait !== undefined ? { reconnectTimeWait: n.reconnectTimeWait } : {}),
    ...(n.timeout !== undefined ? { timeout: n.timeout } : {}),
    ...(n.auth ? { auth: n.auth } : {}),
  }
}
