/**
 * ChunkedRingBuffer — a terminal scrollback buffer that stores output as a list
 * of fixed-size string chunks and drops whole old chunks on overflow, instead of
 * one big string that's re-sliced (O(n) copy) on every chunk once full.
 *
 * Same logical content + monotonically-increasing offset as the old
 * `{content, offset}` shape, but appends are O(1)-ish (no full re-slice).
 * Pure + injectable; deterministic for tests.
 */

export interface ChunkedRingBufferOptions {
  /** max retained content size in chars (default 200_000). */
  maxSize?: number
  /** chunk size in chars (default 16_384). */
  chunkSize?: number
}

const DEFAULT_MAX = 200_000
const DEFAULT_CHUNK = 16_384

export class ChunkedRingBuffer {
  private chunks: string[] = []
  private readonly maxSize: number
  private readonly chunkSize: number
  /** total chars currently retained. */
  private retained = 0
  /** total chars ever appended (monotonic; matches the old `offset`). */
  offset = 0

  constructor(opts: ChunkedRingBufferOptions = {}) {
    this.maxSize = Math.max(1, opts.maxSize ?? DEFAULT_MAX)
    this.chunkSize = Math.max(256, opts.chunkSize ?? DEFAULT_CHUNK)
  }

  /** Append data; drops whole old chunks if over maxSize. */
  append(data: string): void {
    if (!data) return
    this.offset += data.length
    let rest = data
    while (rest.length > 0) {
      const last = this.chunks[this.chunks.length - 1]
      if (last !== undefined && last.length < this.chunkSize) {
        const take = Math.min(this.chunkSize - last.length, rest.length)
        this.chunks[this.chunks.length - 1] = last + rest.slice(0, take)
        this.retained += take
        rest = rest.slice(take)
      } else {
        const take = Math.min(this.chunkSize, rest.length)
        this.chunks.push(rest.slice(0, take))
        this.retained += take
        rest = rest.slice(take)
      }
    }
    this.evict()
  }

  /** Drop oldest whole chunks until retained <= maxSize. */
  private evict(): void {
    while (this.retained > this.maxSize && this.chunks.length > 0) {
      const head = this.chunks[0]
      // If dropping the whole head still leaves us over, drop it; otherwise
      // trim only the needed prefix off the head (keep chunk boundaries intact).
      if (this.retained - head.length >= this.maxSize) {
        this.chunks.shift()
        this.retained -= head.length
      } else {
        const trim = this.retained - this.maxSize
        this.chunks[0] = head.slice(trim)
        this.retained -= trim
        break
      }
    }
  }

  /** The retained content as a single string (for reads/search). */
  content(): string {
    return this.chunks.join('')
  }

  /** Retained size in chars. */
  size(): number {
    return this.retained
  }

  /** Number of chunks (for tests/diagnostics). */
  chunkCount(): number {
    return this.chunks.length
  }

  clear(): void {
    this.chunks = []
    this.retained = 0
    this.offset = 0
  }
}
