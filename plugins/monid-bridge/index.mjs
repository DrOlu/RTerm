/**
 * monid-bridge — thin wrapper around the official Monid CLI.
 *
 * Settings → Plugins → Monid (settings.monid):
 *   enabled, binaryPath, keyLabel
 * The API key is NEVER stored in settings.json. Saving a key in the UI runs
 * `monid keys add -k <key> -l <label>` (see applyMonidApiKey).
 *
 * Agent tools: monid_health, monid_discover, monid_run.
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

/** Build argv for a monid subcommand. Pure. */
export function buildMonidArgv(sub, params = {}) {
  switch (sub) {
    case 'version':
      return ['--version']
    case 'keys-list':
      return ['keys', 'list']
    case 'discover': {
      const q = String(params.query || '').trim()
      if (!q) throw new Error('monid_discover needs a query')
      return ['discover', q]
    }
    case 'run': {
      const tool = String(params.tool || '').trim()
      if (!tool) throw new Error('monid_run needs a tool name')
      const argv = ['run', tool]
      if (params.input != null && String(params.input).trim()) {
        argv.push('--input', String(params.input))
      }
      return argv
    }
    default:
      throw new Error(`unknown monid subcommand: ${sub}`)
  }
}

async function runMonid(ctx, cfg, argv) {
  if (typeof ctx.runCommand === 'function') {
    const cmdline = [cfg.binaryPath, ...argv].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
    return ctx.runCommand({ command: cmdline })
  }
  if (typeof ctx.exec === 'function') {
    const cmdline = [cfg.binaryPath, ...argv].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
    return ctx.exec(cmdline)
  }
  const { execFile } = require('node:child_process')
  return new Promise((resolve) => {
    execFile(cfg.binaryPath, argv, { timeout: 120000, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        exitCode: err?.code ?? 0,
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
      hint: 'Install @monid-ai/cli (`npm i -g @monid-ai/cli`) and paste an API key in Settings → Plugins → Monid (https://app.monid.ai/access/api-keys).',
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
        return { binaryPath: cfg.binaryPath, keyLabel: cfg.keyLabel, version: ver, keys }
      }, log),
  })

  registerTool({
    name: 'monid_discover',
    description: 'Discover Monid tools/endpoints for a task (web data, enrichment, social, company/people). Use before writing a scraper or when a generic fetch is not enough.',
    params: {
      query: { type: 'string', description: 'What you need (e.g. "linkedin company employees")' },
    },
    handler: async (p) =>
      guarded(async () => {
        const argv = buildMonidArgv('discover', p)
        const r = await runMonid(ctx, cfg, argv)
        return { argv: [cfg.binaryPath, ...argv], ...r }
      }, log),
  })

  registerTool({
    name: 'monid_run',
    description: 'Run a named Monid tool with optional JSON/text input. Prefer this over hand-rolled scrapers when discover returned a tool.',
    params: {
      tool: { type: 'string', description: 'Tool name from monid_discover' },
      input: { type: 'string', description: 'JSON or text input for the tool', optional: true },
    },
    handler: async (p) =>
      guarded(async () => {
        const argv = buildMonidArgv('run', p)
        const r = await runMonid(ctx, cfg, argv)
        return { argv: [cfg.binaryPath, ...argv], ...r }
      }, log),
  })
}
