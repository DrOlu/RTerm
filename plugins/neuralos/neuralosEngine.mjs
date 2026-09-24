/**
 * neuralosEngine — the neuralOS runtime for the RTerm neuralos plugin.
 *
 * neuralOS instances are on-device data agents: each instance directory
 * carries a probe menu (needle_menu.json) over a real data source, the
 * 121M engine binary picks the probe that answers a question, and the
 * instance's bridge (Python) executes it against the source. Everything
 * here returns errors as data — a missing engine or instance is an
 * answer, never a thrown exception.
 *
 * Engine resolution order (first existing wins):
 *   1. settings.neuralos.engineBin/engineWeights (or NEURALOS_ENGINE_* env)
 *   2. the desktop bundle: {process.resourcesPath}/neuralos/<per-arch engine>
 *      (electron-builder extraResources; present in the packaged app only)
 *   3. the shared cache ~/.cache/neuralos/ (auto-downloaded on first use —
 *      this is what makes `npm i -g neuralos` self-provisioning: one fetch,
 *      then offline forever)
 *   4. <instancesRoot>/engine/needle (+ needle3.cact) — the fleet convention
 * If nothing exists and autoDownload is enabled, the cache is provisioned
 * from https://huggingface.co/Cactus-Compute/needle3 (public, no auth).
 */

import { execFile as cpExecFile, spawn } from 'node:child_process'
import { promises as fs, constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const HF_BASE = 'https://huggingface.co/Cactus-Compute/needle3/resolve/main'
export const WEIGHTS_NAME = 'needle3.cact'
export const MAX_RESULT_CHARS = 6000

/** Per-arch bundled engine name, matching the release-workflow download. */
export function bundledEngineName(platform, arch) {
  const os = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux'
  if (os === 'macos') return arch === 'arm64' ? 'engine-macos-arm64' : null
  if (os === 'linux') return arch === 'arm64' ? 'engine-linux-arm64' : arch === 'x64' ? 'engine-linux-x86_64' : null
  return arch === 'arm64' ? 'engine-windows-arm64.exe' : arch === 'x64' ? 'engine-windows-x86_64.exe' : null
}

/** The HF platform folder for a bundled engine name. */
export function hfFolderFor(platform, arch) {
  const os = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux'
  if (os === 'macos') return 'macos-arm64'
  if (os === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x86_64'
  return arch === 'arm64' ? 'windows-arm64' : 'windows-x86_64'
}

export function cacheDir(env = process.env) {
  if (env.NEURALOS_CACHE_DIR) return env.NEURALOS_CACHE_DIR
  return path.join(homedir(), '.cache', 'neuralos')
}

/** Settings block -> env -> default. Blank values mean unset. */
function pick(settingsValue, envValue, fallback) {
  const s = typeof settingsValue === 'string' ? settingsValue.trim() : ''
  if (s) return s
  const e = typeof envValue === 'string' ? envValue.trim() : ''
  if (e) return e
  return fallback
}

export function resolveConfig(ctx = {}, env = process.env) {
  const settings = (typeof ctx.getSettings === 'function' ? ctx.getSettings() : ctx.settings) || {}
  const block = settings.neuralos || {}
  return {
    instancesDir: pick(block.instancesDir, env.NEURALOS_INSTANCES_DIR, path.join(homedir(), 'neuralos-instances')),
    pythonBin: pick(block.pythonBin, env.NEURALOS_PYTHON, 'python3'),
    engineBin: pick(block.engineBin, env.NEURALOS_ENGINE_BIN) || null,
    engineWeights: pick(block.engineWeights, env.NEURALOS_ENGINE_WEIGHTS) || null,
    autoDownload: block.autoDownload !== false && env.NEURALOS_AUTO_DOWNLOAD !== '0',
    cacheDir: pick(block.cacheDir, env.NEURALOS_CACHE_DIR, cacheDir(env)),
    timeoutMs: Number(block.timeoutMs) > 0 ? Number(block.timeoutMs) : 120000,
  }
}

/** Default execFile promisified; injectable for the spec. */
export function defaultExec() {
  return (cmd, args, opts = {}) =>
    new Promise((resolve) => {
      const execEnv = opts.env ? { ...process.env, ...opts.env } : process.env
      const child = cpExecFile(cmd, args, { timeout: opts.timeoutMs ?? 120000, maxBuffer: 16 * 1024 * 1024, env: execEnv }, (err, stdout, stderr) => {
        resolve({ ok: !err, code: err ? err.code ?? 1 : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
      void child
    })
}

async function exists(p) {
  try {
    await fs.access(p, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Download one file over HTTPS into dir with its basename (idempotent). */
async function download(deps, url, dir) {
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, path.basename(url))
  if (await exists(target)) return target
  const tmp = `${target}.part`
  if (!deps.fetchImpl) {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`download ${url} -> HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await fs.writeFile(tmp, buf)
  } else {
    await deps.fetchImpl(url, tmp)
  }
  await fs.rename(tmp, target)
  return target
}

/**
 * Provision the shared cache with the weights + this platform's engine.
 * One-time (~36 MB); afterwards everything resolves offline. Injectable
 * fetch/download for the spec; the real path uses global fetch (Node >=18).
 */
export async function ensureEngine(deps, { force = false } = {}) {
  const engineName = bundledEngineName(deps.platform ?? process.platform, deps.arch ?? process.arch)
  if (!engineName) return { error: `no published neuralOS engine for ${deps.platform ?? process.platform}-${deps.arch ?? process.arch}` }
  const dir = deps.cacheDir ?? cacheDir()
  const weightsPath = path.join(dir, WEIGHTS_NAME)
  const enginePath = path.join(dir, engineName)
  try {
    if (force || !(await exists(weightsPath))) {
      await download(deps, `${HF_BASE}/${WEIGHTS_NAME}`, dir)
    }
    if (force || !(await exists(enginePath))) {
      await download(deps, `${HF_BASE}/${hfFolderFor(deps.platform ?? process.platform, deps.arch ?? process.arch)}/${engineName.startsWith('engine-windows') ? 'needle.exe' : 'needle'}`, dir)
      // HF keeps upstream names; rename to the per-arch bundled name.
      const raw = engineName.startsWith('engine-windows') ? 'needle.exe' : 'needle'
      const rawPath = path.join(dir, raw)
      if (rawPath !== enginePath && (await exists(rawPath))) await fs.rename(rawPath, enginePath)
    }
    await fs.chmod(enginePath, 0o755).catch(() => {})
    return { engineBin: enginePath, engineWeights: weightsPath }
  } catch (e) {
    return { error: `engine auto-download failed: ${String(e?.message ?? e)}` }
  }
}

export async function resolveEngine(cfg, deps = {}) {
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch
  const candidates = []
  if (cfg.engineBin && cfg.engineWeights) candidates.push({ bin: cfg.engineBin, weights: cfg.engineWeights })
  const resources = (deps.resourcesPath ?? process.resourcesPath) ?? undefined
  const bundled = bundledEngineName(platform, arch)
  if (resources && bundled) {
    candidates.push({ bin: path.join(resources, 'neuralos', bundled), weights: path.join(resources, 'neuralos', WEIGHTS_NAME) })
  }
  if (bundled) {
    candidates.push({ bin: path.join(cfg.cacheDir, bundled), weights: path.join(cfg.cacheDir, WEIGHTS_NAME) })
  }
  candidates.push({ bin: path.join(cfg.instancesDir, 'engine', 'needle'), weights: path.join(cfg.instancesDir, 'engine', WEIGHTS_NAME) })
  for (const c of candidates) {
    if ((await exists(c.bin)) && (await exists(c.weights))) return { engineBin: c.bin, engineWeights: c.weights }
  }
  if (cfg.autoDownload) {
    return ensureEngine({ ...deps, cacheDir: cfg.cacheDir, platform, arch })
  }
  return { error: 'neuralOS engine not found — set neuralos.engineBin/engineWeights (settings), install the desktop bundle, or enable autoDownload' }
}

export function parseJsonObject(text) {
  try {
    return JSON.parse(text)
  } catch {
    const first = text.indexOf('{')
    const last = text.lastIndexOf('}')
    if (first === -1 || last <= first) return null
    try {
      return JSON.parse(text.slice(first, last + 1))
    } catch {
      return null
    }
  }
}

export async function listInstances(cfg, deps = {}) {
  const readdir = deps.readdir ?? fs.readdir
  const readFile = deps.readFile ?? fs.readFile
  let entries
  try {
    entries = await readdir(cfg.instancesDir, { withFileTypes: true })
  } catch {
    return { error: `no instances directory at ${cfg.instancesDir} — set neuralos.instancesDir (settings) or NEURALOS_INSTANCES_DIR` }
  }
  const instances = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(cfg.instancesDir, entry.name)
    try {
      const raw = await readFile(path.join(dir, 'needle_menu.json'), 'utf-8')
      const menu = JSON.parse(raw)
      if (!Array.isArray(menu)) continue
      instances.push({ name: entry.name, probeCount: menu.length, probes: menu.slice(0, 40).map((t) => t.name) })
    } catch {
      continue
    }
  }
  return instances
}

export async function instanceDirFor(cfg, instance) {
  if (!/^[A-Za-z0-9._-]+$/.test(instance)) return { error: `invalid instance name: ${instance}` }
  const dir = path.join(cfg.instancesDir, instance)
  if (!(await exists(path.join(dir, 'needle_menu.json')))) {
    return { error: `no instance named '${instance}' (see neuralos_list_instances)` }
  }
  return dir
}

export async function engineSelect(exec, engine, menuPath, question, opts = {}) {
  let out
  try {
    out = await exec(engine.engineBin, ['--model', engine.engineWeights, '--tools', menuPath, '--prompt', question], { timeoutMs: opts.timeoutMs })
  } catch (e) {
    return { error: `engine execution failed: ${String(e?.message ?? e)}` }
  }
  if (out.code !== 0 && !out.stdout.trim()) return { error: `engine exited ${out.code}: ${out.stderr.slice(0, 200)}` }
  const parsed = parseJsonObject(out.stdout)
  if (!parsed) return { error: `engine output not JSON: ${out.stdout.slice(0, 120)}` }
  const calls = parsed.function_calls
  if (!Array.isArray(calls) || calls.length === 0 || !calls[0]?.name) {
    return { error: 'engine refused the question (no call selected)' }
  }
  return { pick: calls[0].name, args: calls[0].arguments ?? {}, confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null }
}

const PROBE_RUNNER = [
  'import json, os, sys',
  'sys.path.insert(0, os.environ["NEURALOS_INSTANCE_DIR"])',
  'import bridge',
  'fn = getattr(bridge, os.environ["NEURALOS_PROBE"], None)',
  'if fn is None:',
  '    print(json.dumps({"error": "unknown probe", "probe": os.environ["NEURALOS_PROBE"]}))',
  'else:',
  '    print(json.dumps(fn(**json.loads(os.environ.get("NEURALOS_ARGS", "{}"))), default=str))',
].join('\n')

export async function executeProbe(exec, cfg, instanceDir, probe, args, opts = {}) {
  const env = {
    NEURALOS_INSTANCE_DIR: instanceDir,
    NEURALOS_PROBE: probe,
    NEURALOS_ARGS: JSON.stringify(args ?? {}),
  }
  let out
  try {
    out = await exec(cfg.pythonBin, ['-c', PROBE_RUNNER], { ...opts, env })
  } catch (e) {
    return { error: `probe execution failed: ${String(e?.message ?? e)}` }
  }
  if (out.code !== 0 && !out.stdout.trim()) return { error: `probe exited ${out.code}: ${out.stderr.slice(0, 200)}` }
  const parsed = parseJsonObject(out.stdout)
  if (!parsed || typeof parsed !== 'object') return { error: `probe output not JSON: ${out.stdout.slice(0, 120)}` }
  return parsed
}

/**
 * Graph probes execute DIRECTLY by name (bypassing engine selection): probe
 * names follow the instance convention <prefix>_graph_<op>, and the 121M
 * model grounds numeric fragments poorly — direct execution is the fix.
 */
export async function graphProbe(exec, cfg, instanceDir, input) {
  if (!['overview', 'neighbors', 'connect'].includes(input.op)) return { error: `unknown graph op: ${input.op}` }
  const raw = await fs.readFile(path.join(instanceDir, 'needle_menu.json'), 'utf-8')
  const menu = JSON.parse(raw)
  const graphNames = menu.map((t) => t.name).filter((n) => n.includes('_graph_'))
  const probe = graphNames.find((n) => n.endsWith(`_graph_${input.op}`))
  if (!probe) return { error: `this instance has no ${input.op} graph probe`, available_graph_probes: graphNames }
  const args = input.op === 'neighbors' ? { node: input.node ?? '' } : input.op === 'connect' ? { a: input.a ?? '', b: input.b ?? '' } : {}
  const result = await executeProbe(exec, cfg, instanceDir, probe, args)
  return { probe, ...result }
}

/**
 * Admin probes are write-capable bridge functions; the confirm='yes' literal
 * is the operator interlock (enforced at the tool schema) and this guard
 * keeps probe names to plain identifiers.
 */
export async function adminProbe(exec, cfg, instanceDir, probe, args) {
  if (!/^[A-Za-z0-9_]+$/.test(probe)) return { error: `invalid probe name: ${probe}` }
  const result = await executeProbe(exec, cfg, instanceDir, probe, args ?? {})
  return { probe, admin: true, result }
}

export function truncate(value, max = MAX_RESULT_CHARS) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… (truncated at ${max} chars)`
}

/** Streamed engine invocation for long-running selections (unused by default). */
export function engineSelectStreamed(engine, menuPath, question) {
  return spawn(engine.engineBin, ['--model', engine.engineWeights, '--tools', menuPath, '--prompt', question], { stdio: ['ignore', 'pipe', 'pipe'] })
}