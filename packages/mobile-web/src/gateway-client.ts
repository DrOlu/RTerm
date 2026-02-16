import type {
  GatewayEvent,
  GatewayIncomingEnvelope,
  RpcRequest,
  UIUpdateAction
} from './types'

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

type GatewayClientEventMap = {
  uiUpdate: (action: UIUpdateAction) => void
  gatewayEvent: (event: GatewayEvent) => void
  raw: (channel: string, payload: unknown) => void
  status: (status: ConnectionStatus, detail?: string) => void
  error: (message: string) => void
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_RPC_TIMEOUT = 15000

function formatCloseDetail(event: CloseEvent): string {
  const code = Number.isFinite(event.code) ? event.code : 1006
  const reason = typeof event.reason === 'string' ? event.reason.trim() : ''
  const cleanSuffix = event.wasClean ? ', clean' : ', unclean'
  return reason ? `code=${code}${cleanSuffix}, reason=${reason}` : `code=${code}${cleanSuffix}`
}

export class GatewayClient {
  private socket: WebSocket | null = null
  private nextRequestId = 1
  private pending = new Map<string, PendingRequest>()
  private manualClose = false

  private listeners: {
    [K in keyof GatewayClientEventMap]: Set<GatewayClientEventMap[K]>
  } = {
    uiUpdate: new Set(),
    gatewayEvent: new Set(),
    raw: new Set(),
    status: new Set(),
    error: new Set()
  }

  on<K extends keyof GatewayClientEventMap>(
    event: K,
    listener: GatewayClientEventMap[K]
  ): () => void {
    this.listeners[event].add(listener)
    return () => {
      this.listeners[event].delete(listener)
    }
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  async connect(url: string, timeoutMs = 4000): Promise<void> {
    this.disconnect()
    this.manualClose = false
    this.emit('status', 'connecting')

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url)
      this.socket = socket
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          socket.close()
        } catch {
          // ignore close errors
        }
        reject(new Error(`Connection timeout (${timeoutMs}ms)`))
      }, timeoutMs)

      socket.onopen = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.emit('status', 'connected')
        resolve()
      }

      socket.onerror = () => {
        this.emit('error', 'WebSocket transport error')
      }

      socket.onclose = (event) => {
        clearTimeout(timer)
        this.rejectAllPending(new Error(`Socket closed (${event.code})`))
        this.socket = null
        if (!this.manualClose && !settled) {
          settled = true
          reject(new Error(`Socket closed before connected (${event.code})`))
        }
        const reason = formatCloseDetail(event)
        this.emit('status', 'disconnected', reason)
      }

      socket.onmessage = (event) => {
        void this.handleIncoming(event.data)
      }
    })
  }

  disconnect(): void {
    this.manualClose = true
    if (!this.socket) return
    try {
      this.socket.close()
    } catch {
      // ignore close errors
    }
    this.rejectAllPending(new Error('Socket disconnected'))
    this.socket = null
  }

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_RPC_TIMEOUT
  ): Promise<T> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway socket is not connected')
    }

    const id = String(this.nextRequestId++)
    const payload: RpcRequest = { id, method, params }

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC timeout: ${method}`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })

      try {
        socket.send(JSON.stringify(payload))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private emit<K extends keyof GatewayClientEventMap>(
    event: K,
    ...args: Parameters<GatewayClientEventMap[K]>
  ): void {
    this.listeners[event].forEach((listener) => {
      try {
        ;(listener as (...values: Parameters<GatewayClientEventMap[K]>) => void)(...args)
      } catch (error) {
        console.error(`[GatewayClient] Listener error for ${event}:`, error)
      }
    })
  }

  private rejectAllPending(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }

  private async handleIncoming(raw: unknown): Promise<void> {
    const text = await this.coerceToText(raw)
    let payload: GatewayIncomingEnvelope

    try {
      payload = JSON.parse(text) as GatewayIncomingEnvelope
    } catch {
      this.emit('error', `Invalid JSON received: ${text.slice(0, 120)}`)
      return
    }

    if (!payload || typeof payload !== 'object' || !('type' in payload)) return

    if (payload.type === 'gateway:response') {
      const pending = this.pending.get(payload.id)
      if (!pending) return

      clearTimeout(pending.timer)
      this.pending.delete(payload.id)

      if (payload.ok) {
        pending.resolve(payload.result)
      } else {
        pending.reject(new Error(`${payload.error.code}: ${payload.error.message}`))
      }
      return
    }

    if (payload.type === 'gateway:ui-update') {
      this.emit('uiUpdate', payload.payload)
      return
    }

    if (payload.type === 'gateway:event') {
      this.emit('gatewayEvent', payload.payload)
      return
    }

    if (payload.type === 'gateway:raw') {
      this.emit('raw', payload.channel, payload.payload)
    }
  }

  private async coerceToText(raw: unknown): Promise<string> {
    if (typeof raw === 'string') return raw
    if (raw instanceof Blob) return await raw.text()
    if (raw instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(raw))
    if (ArrayBuffer.isView(raw)) {
      return new TextDecoder().decode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
    }
    return String(raw)
  }
}
