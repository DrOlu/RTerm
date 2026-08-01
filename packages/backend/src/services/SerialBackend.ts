import { randomUUID } from 'node:crypto'
import type {
  BaseConnectionConfig,
  TerminalConfig,
  TerminalSystemInfo,
  TerminalBackend,
} from '../types'

/**
 * Serial console backend (Netcatty-parity). Connects to a local serial port
 * (USB-to-serial adapter → Cisco console, etc.) and presents it as a live PTY
 * tab — unlike WinRM, serial IS a real byte stream so write/resize/data/exit
 * all behave like a normal terminal.
 *
 * The `serialport` npm module is a NATIVE addon; to avoid forcing every
 * install/build/CI to compile it, this backend lazy-`require`s it at spawn
 * time. If it isn't installed, spawn throws a clear, actionable error. Unit
 * tests inject a fake module via `SerialBackend.setSerialModuleForTest`.
 *
 * NOT end-to-end tested (no serial hardware here) — backend logic is unit
 * tested with a mock transport.
 */

export interface SerialConnectionConfig extends BaseConnectionConfig {
  type: 'serial'
  /** OS path to the serial device, e.g. /dev/ttyUSB0 or COM3. */
  path: string
  baudRate: number
  dataBits?: 5 | 6 | 7 | 8
  parity?: 'none' | 'even' | 'odd'
  stopBits?: 1 | 2
  flowControl?: 'none' | 'xon/xoff' | 'rts/cts'
}

/** Minimal shape of the serialport Port constructor we use. */
export interface SerialPortLike {
  on(event: 'open' | 'data' | 'close' | 'error', cb: (...args: any[]) => void): void
  write(data: Buffer | string, cb?: (err?: Error | null) => void): void
  close(cb?: (err?: Error | null) => void): void
  set(opts: { rts?: boolean; cts?: boolean; dtr?: boolean }, cb?: (err?: Error | null) => void): void
  /** send a break signal (network-gear password recovery / ROMMON). */
  break?(opts?: { duration?: number }, cb?: (err?: Error | null) => void): void
}

/**
 * The serialport constructor. Across versions the export shape and call
 * signature differ:
 *  - v9:  the module itself IS the constructor, called `new SerialPort(path, opts)`.
 *  - v10+: the class is the `SerialPort` named export, called `new SerialPort({path, ...opts})`.
 * We normalise both to a single factory taking `(path, opts)`.
 */
export type SerialPortFactory = (path: string, opts: any) => SerialPortLike

interface SerialInstance {
  config: SerialConnectionConfig
  port: SerialPortLike
  dataCallback?: (data: string) => void
  exitCallback?: (code: number) => void
  ready: boolean
  /** set when the port errored (distinguishes 'failed' from 'not-found' in getInitializationState). */
  failed?: boolean
}

let injectedSerial: SerialPortFactory | null = null
let lazySerial: SerialPortFactory | null | undefined

/** Call a serialport constructor/factory, tolerating both `new Ctor(path, opts)`
 * (v9 + class-injected test fakes) and the v10+ object form `new Ctor({path, ...opts})`. */
function constructPort(Ctor: any, path: string, opts: any): SerialPortLike {
  try {
    return new Ctor(path, opts)
  } catch (e: any) {
    // v10+ throws a TypeError (`"path" is not defined`) for the positional form.
    if (e instanceof TypeError) return new Ctor({ path, ...opts })
    throw e
  }
}

export class SerialBackend implements TerminalBackend {
  private instances = new Map<string, SerialInstance>()
  /** ids whose port errored (removed from instances but remembered as 'failed'). */
  private failedIds = new Set<string>()

  /** For tests: inject a fake serialport constructor/factory. */
  static setSerialModuleForTest(mod: SerialPortFactory | null): void {
    injectedSerial = mod
  }

  private loadSerial(): SerialPortFactory | null {
    if (injectedSerial) return injectedSerial
    if (lazySerial !== undefined) return lazySerial
    try {
      // Lazy require so the module isn't loaded when serial isn't used.
      // Export shape differs by version: v9 exports the constructor AS the
      // module; v10+ puts it on the `SerialPort` named export. Resolve the class.
      const mod = require('serialport')
      const Ctor = typeof mod?.SerialPort === 'function' ? mod.SerialPort : mod
      lazySerial = ((path: string, opts: any) => constructPort(Ctor, path, opts)) as SerialPortFactory
    } catch {
      lazySerial = null
    }
    return lazySerial
  }

  spawn(config: TerminalConfig): Promise<string> {
    if (config.type !== 'serial') {
      throw new Error('SerialBackend only supports serial connections')
    }
    const cfg = config as unknown as SerialConnectionConfig
    const createPort = this.loadSerial()
    if (!createPort) {
      throw new Error(
        'Serial port support requires the `serialport` npm package, which is not installed. Install it in RTerm to use serial console connections.',
      )
    }
    const ptyId = `serial-${randomUUID()}`
    const port = constructPort(createPort as any, cfg.path, {
      baudRate: cfg.baudRate,
      dataBits: cfg.dataBits ?? 8,
      parity: cfg.parity ?? 'none',
      stopBits: cfg.stopBits ?? 1,
      flowControl: cfg.flowControl === 'xon/xoff' || cfg.flowControl === 'rts/cts',
      autoOpen: true,
    })
    const instance: SerialInstance = { config: cfg, port, ready: false }
    this.instances.set(ptyId, instance)

    port.on('open', () => {
      instance.ready = true
      instance.dataCallback?.(
        `\x1b[32m✔ Serial connection opened: ${cfg.path} @ ${cfg.baudRate} baud.\x1b[0m\r\n`,
      )
    })
    port.on('data', (buf: Buffer) => {
      instance.dataCallback?.(buf.toString('utf8'))
    })
    port.on('close', () => {
      instance.exitCallback?.(0)
    })
    port.on('error', (err: Error) => {
      instance.dataCallback?.(`\x1b[31m✘ Serial error: ${err.message}\x1b[0m\r\n`)
      instance.failed = true
      instance.exitCallback?.(-1)
      // Clean up the failed instance so it doesn't leak in the map (a dead port
      // is never usable again), but remember it failed so getInitializationState
      // can still report 'failed' (vs 'not-found').
      this.instances.delete(ptyId)
      this.failedIds.add(ptyId)
    })

    return Promise.resolve(ptyId)
  }

  write(ptyId: string, data: string): void {
    const inst = this.instances.get(ptyId)
    if (inst) inst.port.write(data)
  }

  resize(_ptyId: string, _cols: number, _rows: number): void {
    // Serial console has no PTY size; no-op (matches real serial terminals).
  }

  kill(ptyId: string): void {
    this.failedIds.delete(ptyId)
    const inst = this.instances.get(ptyId)
    if (!inst) return
    this.instances.delete(ptyId)
    try { inst.port.close() } catch { /* ignore */ }
    inst.exitCallback?.(0)
  }

  onData(ptyId: string, cb: (data: string) => void): void {
    const inst = this.instances.get(ptyId)
    if (inst) inst.dataCallback = cb
  }

  onExit(ptyId: string, cb: (code: number) => void): void {
    const inst = this.instances.get(ptyId)
    if (inst) inst.exitCallback = cb
  }

  getCwd(_ptyId: string): string | undefined { return undefined }

  getHomeDir(_ptyId: string): Promise<string | undefined> { return Promise.resolve(undefined) }

  getRemoteOs(_ptyId: string): 'unix' | 'windows' | undefined {
    // Serial console OS is unknown (it's whatever device is on the wire).
    return undefined
  }

  async getSystemInfo(_ptyId: string): Promise<TerminalSystemInfo | undefined> {
    return undefined
  }

  getInitializationState(ptyId: string): 'ready' | 'failed' | undefined {
    const inst = this.instances.get(ptyId)
    if (inst) return inst.ready ? 'ready' : undefined
    if (this.failedIds.has(ptyId)) return 'failed'
    return undefined
  }

  // --- Serial-specific controls (v3.0.5) ---

  /** Send a BREAK signal (Cisco password recovery / ROMMON). Default 500ms. */
  sendBreak(ptyId: string, durationMs = 500): boolean {
    const inst = this.instances.get(ptyId)
    if (!inst || typeof inst.port.break !== 'function') return false
    try {
      inst.port.break({ duration: durationMs }, (err) => {
        if (err) inst.dataCallback?.(`\x1b[31m✘ Break failed: ${err.message}\x1b[0m\r\n`)
      })
      return true
    } catch {
      return false
    }
  }

  /** Set modem control lines (DTR/RTS/CTS). */
  setControlLines(ptyId: string, lines: { rts?: boolean; cts?: boolean; dtr?: boolean }): boolean {
    const inst = this.instances.get(ptyId)
    if (!inst || typeof inst.port.set !== 'function') return false
    try {
      inst.port.set(lines, (err) => {
        if (err) inst.dataCallback?.(`\x1b[31m✘ set() failed: ${err.message}\x1b[0m\r\n`)
      })
      return true
    } catch {
      return false
    }
  }
}
