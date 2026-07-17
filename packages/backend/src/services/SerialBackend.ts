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
}

export interface SerialPortConstructor {
  new (path: string, opts: any): SerialPortLike
}

interface SerialInstance {
  config: SerialConnectionConfig
  port: SerialPortLike
  dataCallback?: (data: string) => void
  exitCallback?: (code: number) => void
  ready: boolean
}

let injectedSerial: SerialPortConstructor | null = null
let lazySerial: SerialPortConstructor | null | undefined

export class SerialBackend implements TerminalBackend {
  private instances = new Map<string, SerialInstance>()

  /** For tests: inject a fake serialport constructor. */
  static setSerialModuleForTest(mod: SerialPortConstructor | null): void {
    injectedSerial = mod
  }

  private loadSerial(): SerialPortConstructor | null {
    if (injectedSerial) return injectedSerial
    if (lazySerial !== undefined) return lazySerial
    try {
      // Lazy require so the module isn't loaded when serial isn't used.
      lazySerial = require('serialport') as unknown as SerialPortConstructor
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
    const SerialPort = this.loadSerial()
    if (!SerialPort) {
      throw new Error(
        'Serial port support requires the `serialport` npm package, which is not installed. Install it in RTerm to use serial console connections.',
      )
    }
    const ptyId = `serial-${randomUUID()}`
    const port = new SerialPort(cfg.path, {
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
      instance.exitCallback?.(-1)
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
    if (!inst) return undefined
    return inst.ready ? 'ready' : undefined
  }
}
