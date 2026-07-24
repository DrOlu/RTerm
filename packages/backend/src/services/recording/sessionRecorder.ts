/**
 * sessionRecorder — asciinema-style terminal session recording + replay
 * (Tier 3). Captures the timed output stream of a terminal tab (separate from
 * the plain-text session log) so a session can be played back with its real
 * timing, exported to the standard asciinema .cast format, and used for
 * training/audit.
 *
 * Pure + injectable: the clock is injected; events are recorded with relative
 * timestamps and replayed/scrubbed deterministically.
 */

import { randomUUID } from 'crypto'

export type RecordEventKind = 'out' | 'in' | 'resize' | 'marker'

export interface RecordEvent {
  /** seconds since recording started (>= 0). */
  t: number
  kind: RecordEventKind
  /** payload: text for out/in, "COLSxROWS" for resize, label for marker. */
  data: string
}

export interface RecordingHeader {
  version: 2
  width: number
  height: number
  timestamp: number
  title?: string
  env?: Record<string, string>
}

export interface Recording {
  id: string
  terminalId: string
  title?: string
  startedAt: number
  endedAt?: number
  width: number
  height: number
  events: RecordEvent[]
}

export interface SessionRecorderDeps {
  now?: () => number
  /** cap on events per recording (default 100_000). */
  eventLimit?: number
}

/** Serialize a recording to asciinema .cast (v2) format — NDJSON. */
export function toAsciinema(rec: Recording): string {
  const header: RecordingHeader = {
    version: 2,
    width: rec.width,
    height: rec.height,
    timestamp: Math.floor(rec.startedAt / 1000),
    ...(rec.title ? { title: rec.title } : {}),
  }
  const lines = [JSON.stringify(header)]
  for (const e of rec.events) {
    // asciinema supports "o" (output), "i" (input), "r" (resize), "m" (marker)
    const code = e.kind === 'out' ? 'o' : e.kind === 'in' ? 'i' : e.kind === 'resize' ? 'r' : 'm'
    lines.push(JSON.stringify([round3(e.t), code, e.data]))
  }
  return lines.join('\n') + '\n'
}

/** Parse a .cast (v2) NDJSON back into a Recording shape (id regenerated). */
export function fromAsciinema(text: string, terminalId = 'imported'): Recording {
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length === 0) throw new Error('empty .cast file')
  let header: RecordingHeader
  try {
    header = JSON.parse(lines[0])
  } catch {
    throw new Error('invalid .cast header')
  }
  if (header.version !== 2) throw new Error(`unsupported .cast version: ${header.version}`)
  const events: RecordEvent[] = []
  for (let i = 1; i < lines.length; i++) {
    let row: [number, string, string]
    try {
      row = JSON.parse(lines[i])
    } catch {
      continue // tolerate malformed event lines
    }
    if (!Array.isArray(row) || row.length < 3) continue
    const [t, code, data] = row
    const kind: RecordEventKind = code === 'o' ? 'out' : code === 'i' ? 'in' : code === 'r' ? 'resize' : 'marker'
    if (typeof t === 'number' && Number.isFinite(t) && typeof data === 'string') {
      events.push({ t, kind, data })
    }
  }
  return {
    id: randomUUID(),
    terminalId,
    title: header.title,
    startedAt: (header.timestamp ?? 0) * 1000,
    width: header.width ?? 80,
    height: header.height ?? 24,
    events,
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

export class SessionRecorder {
  private readonly recordings = new Map<string, Recording>()
  private readonly now: () => number
  private readonly eventLimit: number

  constructor(deps: SessionRecorderDeps = {}) {
    this.now = deps.now ?? Date.now
    this.eventLimit = deps.eventLimit ?? 100_000
  }

  /** Start recording a terminal. Returns the recording id. */
  start(terminalId: string, opts: { width?: number; height?: number; title?: string } = {}): string {
    const id = randomUUID()
    this.recordings.set(id, {
      id,
      terminalId,
      title: opts.title,
      startedAt: this.now(),
      width: opts.width ?? 80,
      height: opts.height ?? 24,
      events: [],
    })
    return id
  }

  private active(id: string): Recording {
    const r = this.recordings.get(id)
    if (!r) throw new Error(`recording not found: ${id}`)
    if (r.endedAt !== undefined) throw new Error(`recording ${id} already stopped`)
    return r
  }

  /** Append an event. `atMs` is the absolute time (defaults to now). */
  record(id: string, kind: RecordEventKind, data: string, atMs?: number): void {
    const r = this.active(id)
    if (r.events.length >= this.eventLimit) throw new Error(`recording ${id} hit event limit`)
    const at = atMs ?? this.now()
    const t = Math.max(0, (at - r.startedAt) / 1000)
    r.events.push({ t: round3(t), kind, data })
  }

  /** Record output text (convenience). */
  out(id: string, data: string, atMs?: number): void {
    this.record(id, 'out', data, atMs)
  }

  /** Stop a recording. Returns the finished recording. */
  stop(id: string): Recording {
    const r = this.active(id)
    r.endedAt = this.now()
    return r
  }

  get(id: string): Recording | undefined {
    return this.recordings.get(id)
  }

  list(): Array<{ id: string; terminalId: string; title?: string; startedAt: number; endedAt?: number; events: number }> {
    return [...this.recordings.values()]
      .map((r) => ({ id: r.id, terminalId: r.terminalId, title: r.title, startedAt: r.startedAt, endedAt: r.endedAt, events: r.events.length }))
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  delete(id: string): boolean {
    return this.recordings.delete(id)
  }

  /**
   * Replay from `fromSec` for `durationSec` (default: to end). Returns the
   * output events in order with their replay-time offsets (event.t - fromSec).
   */
  replay(id: string, opts: { fromSec?: number; durationSec?: number } = {}): Array<{ t: number; data: string; kind: RecordEventKind }> {
    const r = this.recordings.get(id)
    if (!r) throw new Error(`recording not found: ${id}`)
    const from = Math.max(0, opts.fromSec ?? 0)
    const to = opts.durationSec !== undefined ? from + Math.max(0, opts.durationSec) : Infinity
    return r.events
      .filter((e) => e.t >= from && e.t < to)
      .map((e) => ({ t: round3(e.t - from), data: e.data, kind: e.kind }))
  }

  /** Export to .cast. */
  exportCast(id: string): string {
    const r = this.recordings.get(id)
    if (!r) throw new Error(`recording not found: ${id}`)
    return toAsciinema(r)
  }
}
