/**
 * monid-bridge — thin wrapper around the official Monid CLI (v0.1.6).
 *
 * Settings → Plugins → Monid (settings.monid): enabled, binaryPath, keyLabel
 * API key is NEVER stored in settings.json (`monid keys add -k … -l …`).
 *
 * Agent tools: monid_health, monid_discover, monid_inspect, monid_run.
 *
 * Argv MUST match `monid <cmd> --help`:
 *   discover --query <q> [--limit n] [--min-score s] --json
 *   inspect  --provider <p> --endpoint <e> --json
 *   run      --provider <p> --endpoint <e> [--input json] [--query json] [--path json] --json
 * Bare `discover <query>` / `run <tool>` are false positives (CLI rejects them).
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export function resolveConfig(ctx = {}, env = process.env) {
  const s = (typeof ctx.getSettings === 'function' ? ctx.getSettings() : ctx.settings) || {}
  const b = s.monid || {}
  return {
    enabled: b.enabled !== false,
    binaryPath: b.binaryPath || env.MONID_BIN || 'monid',
    keyLabel: b.keyLabel || 'rterm',
  }
}

function reqStr(v, name) {
  const s = String(v ?? '').trim()
  if (!s) throw new Error(`${name} is required`)
  return s
}

function optJsonFlag(argv, flag, value) {
  if (value == null) return
  const s = typeof value === 'string' ? value.trim() : JSON.stringify(value)
  if (!s) return
  argv.push(flag, s)
}

function optNumFlag(argv, flag, value) {
  if (value == null || value === '') return
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`${flag} must be a number`)
  argv.push(flag, String(n))
}

/**
 * Build argv AFTER the binary name.
 * Always pass --json so agents get structured output (no ANSI).
 */
export function buildMonidArgv(sub, params = {}) {
  switch (sub) {
    case 'version':
      return ['--version']
    case 'keys-list':
      return ['keys', 'list']
    case 'whoami':
      return ['whoami']
    case 'discover': {
      const q = reqStr(params.query, 'query')
      const argv = ['discover', '--query', q]
      optNumFlag(argv, '--limit', params.limit)
      optNumFlag(argv, '--min-score', params.minScore ?? params['min-score'])
      argv.push('--json')
      return argv
    }
    case 'inspect': {
      const provider = reqStr(params.provider, 'provider')
      const endpoint = reqStr(params.endpoint, 'endpoint')
      return ['inspect', '--provider', provider, '--endpoint', endpoint, '--json']
    }
    case 'run': {
      // FN: agents may pass tool="provider/endpoint" from older docs.
      let provider = String(params.provider || '').trim()
      let endpoint = String(params.endpoint || '').trim()
      const tool = String(params.tool || '').trim()
      if ((!provider || !endpoint) && tool) {
        const slash = tool.indexOf('/')
        if (slash > 0) {
          provider = provider || tool.slice(0, slash)
          endpoint = endpoint || tool.slice(slash)
        }
      }
      if (!provider) throw new Error('monid_run needs provider (slug from discover)')
      if (!endpoint) throw new Error('monid_run needs endpoint (path from discover, e.g. /news/search)')
      if (!endpoint.startsWith('/')) {
        throw new Error('endpoint must start with / (Monid endpoint path, not a free-form tool name)')
      }
      const argv = ['run', '--provider', provider, '--endpoint', endpoint]
      const input = params.input ?? params.body
      if (input != null && String(input).trim()) {
        argv.push('--input', typeof input === 'string' ? input : JSON.stringify(input))
      }
      optJsonFlag(argv, '--query', params.queryParams ?? params.query)
      optJsonFlag(argv, '--path', params.pathParams ?? params.path)
      if (params.wait != null && params.wait !== false && params.wait !== '') {
        argv.push('--wait')
        if (params.wait !== true) argv.push(String(params.wait))
      }
      argv.push('--json')
      return argv
    }
    default:
      throw new Error(`unknown monid subcommand: ${sub}`)
  }
}

/** True if argv looks like the broken 3.3.8 shapes (for tests / guards). */
export function isLegacyBrokenArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 2) return false
  if (argv[0] === 'discover' && argv[1] !== '--query' && !argv[1].startsWith('-')) return true
  if (argv[0] === 'run' && argv[1] !== '--provider' && !String(argv[1]).startsWith('-')) return true
  return false
}

async function runMonid(ctx, cfg, argv) {
  const env = { ...process.env, NO_COLOR: '1' }
  if (typeof ctx.runCommand === 'function') {
    const cmdline = [cfg.binaryPath, ...argv].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')
    return ctx.runCommand({ command: cmdline, env })
  }
  if (typeof ctx.exec === 'function') {
    const cmdline = [cfg.binaryPath, ...argv].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')
    return ctx.exec(cmdline, { env })
  }
  const { execFile } = require('node:child_process')
  return new Promise((resolve) => {
    execFile(cfg.binaryPath, argv, { timeout: 120000, env }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        exitCode: typeof err?.code === 'number' ? err.code : err ? 1 : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        error: err ? String(err.message) : undefined,
      })
    })
  })
}

async function guarded(fn, log) {
  try {
    return await fn()
  } catch (e) {
    const msg = e?.message ?? String(e)
    log?.(`[monid] ${msg}`)
    return {
      error: msg,
      hint: 'Install @monid-ai/cli (`npm i -g @monid-ai/cli`) and paste an API key in Settings → Plugins → Monid. discover needs --query; run needs --provider and --endpoint.',
    }
  }
}

export function register(ctx) {
  const { registerTool, log } = ctx
  const cfg = resolveConfig(ctx)
  if (!cfg.enabled) {
    log?.('[monid] disabled in settings.monid.enabled')
    return
  }

  registerTool({
    name: 'monid_health',
    description: 'Check the Monid CLI is installed and list configured key labels (never the secret).',
    params: {},
    handler: async () =>
      guarded(async () => {
        const ver = await runMonid(ctx, cfg, buildMonidArgv('version'))
        const keys = await runMonid(ctx, cfg, buildMonidArgv('keys-list'))
        const who = await runMonid(ctx, cfg, buildMonidArgv('whoami'))
        return { binaryPath: cfg.binaryPath, keyLabel: cfg.keyLabel, version: ver, keys, whoami: who }
      }, log),
  })

  registerTool({
    name: 'monid_discover',
    description:
      'Search Monid data endpoints with natural language (company news, people, enrichment). Uses `monid discover --query`. Do not pass a bare positional query.',
    params: {
      query: { type: 'string', description: 'Natural-language search (required)' },
      limit: { type: 'number', description: 'Max results (max 50)', optional: true },
      minScore: { type: 'number', description: 'Minimum relevance score', optional: true },
    },
    handler: async (p) =>
      guarded(async () => {
        const argv = buildMonidArgv('discover', p)
        const r = await runMonid(ctx, cfg, argv)
        return { argv: [cfg.binaryPath, ...argv], ...r }
      }, log),
  })

  registerTool({
    name: 'monid_inspect',
    description: 'Get full details for one Monid endpoint (`monid inspect --provider --endpoint`).',
    params: {
      provider: { type: 'string', description: 'Provider slug (e.g. context.dev)' },
      endpoint: { type: 'string', description: 'Endpoint path (e.g. /news/search)' },
    },
    handler: async (p) =>
      guarded(async () => {
        const argv = buildMonidArgv('inspect', p)
        const r = await runMonid(ctx, cfg, argv)
        return { argv: [cfg.binaryPath, ...argv], ...r }
      }, log),
  })

  registerTool({
    name: 'monid_run',
    description:
      'Execute a Monid endpoint (`monid run --provider --endpoint`). provider+endpoint from discover; optional JSON --input / --query / --path. Not `monid run <toolName>`.',
    params: {
      provider: { type: 'string', description: 'Provider slug', optional: true },
      endpoint: { type: 'string', description: 'Endpoint path starting with /', optional: true },
      tool: { type: 'string', description: 'Optional shorthand provider/endpoint', optional: true },
      input: { type: 'string', description: 'Body JSON string', optional: true },
      queryParams: { type: 'string', description: 'Query-parameters JSON string', optional: true },
      pathParams: { type: 'string', description: 'Path-parameters JSON string', optional: true },
    },
    handler: async (p) =>
      guarded(async () => {
        const argv = buildMonidArgv('run', p)
        const r = await runMonid(ctx, cfg, argv)
        return { argv: [cfg.binaryPath, ...argv], ...r }
      }, log),
  })
}
