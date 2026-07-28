/**
 * sidecar.mjs — manages the wigolo daemon lifecycle for RTerm's web-intel
 * plugin: lazily start `wigolo serve` on first use, keep a stock RTerm install
 * lean (no browser-engine/on-device-model download unless the user opts in),
 * and report status. Pure + injectable: process spawning and health-probing are
 * injected so it's fully unit-testable offline.
 *
 * Lean-by-default: we start the daemon with WIGOLO_NO_WARMUP=1 so the ~1.5 GB
 * browser engine + on-device models are NOT downloaded at init — search/fetch/
 * crawl work keyless without them. The heavier models download in the background
 * on first use that actually needs them. `warmupOnInit: true` opts into the full
 * upfront download (a background `wigolo init` run).
 */

export const DEFAULT_PORT = 3333
export const DEFAULT_HOST = '127.0.0.1'

/**
 * Build the spawn plan for the wigolo daemon.
 * @param {{ port?: number, host?: string, warmup?: boolean, token?: string }} cfg
 * @returns {{ command: string, args: string[], env: Record<string,string> }}
 */
export function buildServePlan(cfg = {}) {
  const port = cfg.port ?? DEFAULT_PORT
  const host = cfg.host ?? DEFAULT_HOST
  const env = { ...process.env }
  // Lean by default: skip the browser-engine/model warmup unless explicitly on.
  if (cfg.warmup !== true) env.WIGOLO_NO_WARMUP = '1'
  if (cfg.token) env.WIGOLO_API_TOKEN = cfg.token
  return {
    command: 'npx',
    args: ['-y', 'wigolo', 'serve', '--port', String(port), '--host', host],
    env,
  }
}

/** Build the background `wigolo init` plan (the full ~1.5 GB warmup). */
export function buildInitPlan(cfg = {}) {
  const env = { ...process.env }
  if (cfg.token) env.WIGOLO_API_TOKEN = cfg.token
  return { command: 'npx', args: ['-y', 'wigolo', 'init'], env }
}

export class WigoloSidecar {
  /**
   * @param {{
   *   spawnImpl?: (cmd: string, args: string[], opts: object) => any,
   *   healthImpl?: () => Promise<boolean>,
   *   log?: (line: string) => void,
   *   config?: { port?: number, host?: string, warmup?: boolean, token?: string, autoStart?: boolean },
   *   now?: () => number,
   * }} deps — all injectable; defaults are real (child_process + a health probe).
   */
  constructor(deps = {}) {
    this.config = deps.config ?? {}
    this.spawnImpl = deps.spawnImpl
    this.healthImpl = deps.healthImpl
    this.log = deps.log ?? (() => {})
    this.now = deps.now ?? (() => Date.now())
    this.process = null
    this.startedAt = 0
    this.lastError = undefined
  }

  /** Whether the daemon process is believed to be running. */
  isRunning() {
    return this.process != null
  }

  /** Start the daemon (idempotent). Returns the base URL it's expected on. */
  async start() {
    if (this.process) return this.baseUrl()
    if (typeof this.spawnImpl !== 'function') {
      this.lastError = 'no spawnImpl (sidecar spawn not available in this runtime)'
      throw new Error(this.lastError)
    }
    const plan = buildServePlan(this.config)
    this.log(`[web-intel] starting wigolo daemon: ${plan.command} ${plan.args.join(' ')}`)
    try {
      this.process = this.spawnImpl(plan.command, plan.args, {
        env: plan.env,
        detached: true,
        stdio: 'ignore',
      })
      // Detach so the daemon outlives the plugin turn (it serves many agents).
      this.process?.unref?.()
      this.startedAt = this.now()
      this.lastError = undefined
    } catch (e) {
      this.lastError = e?.message ?? String(e)
      this.process = null
      throw e
    }
    return this.baseUrl()
  }

  /** Kick off the full ~1.5 GB warmup in the background (opt-in). */
  async warmupInBackground() {
    if (typeof this.spawnImpl !== 'function') return false
    const plan = buildInitPlan(this.config)
    try {
      const p = this.spawnImpl(plan.command, plan.args, { env: plan.env, detached: true, stdio: 'ignore' })
      p?.unref?.()
      this.log('[web-intel] background wigolo init (browser engine + models) started')
      return true
    } catch {
      return false
    }
  }

  /** Stop the daemon. */
  async stop() {
    if (!this.process) return
    try { this.process.kill?.() } catch { /* best-effort */ }
    this.process = null
  }

  /** Status snapshot for the health tool / panel. */
  status() {
    return {
      running: this.isRunning(),
      baseUrl: this.baseUrl(),
      startedAt: this.startedAt || undefined,
      lastError: this.lastError,
      warmup: this.config.warmup === true ? 'full' : 'lean (no warmup)',
    }
  }

  baseUrl() {
    const host = this.config.host ?? DEFAULT_HOST
    const port = this.config.port ?? DEFAULT_PORT
    return `http://${host}:${port}`
  }
}
