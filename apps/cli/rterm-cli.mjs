#!/usr/bin/env node
/**
 * rterm-cli — a `gyll`-style command CLI for the RTerm / neuralOS backend.
 *
 * Speaks the backend's WebSocket JSON-RPC gateway natively (ws://host:17888).
 * Zero runtime dependencies: Node's built-in WebSocket (>= 21) with a `ws`
 * package fallback.
 *
 * Commands:
 *   rterm ping | version | methods | call | terminals | connections
 *   rterm open <name> | close <tab> | run <tab> <cmd> | fleet <tabs> <cmd>
 *   rterm sessions | chat <session> <msg> | dashboard | metrics
 */

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_HOST = process.env.RTERM_HOST || '127.0.0.1'
const DEFAULT_PORT = Number(process.env.RTERM_PORT || 17888)
const DEFAULT_URL = process.env.RTERM_URL || `ws://${DEFAULT_HOST}:${DEFAULT_PORT}`

// ── tiny arg parser ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

// ── error formatting (fix: errors used to print "[object Object]") ──────────

/** Extract a readable message from any thrown/rejected value. */
function errorMessage(value) {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    // Gateway errors arrive as { code, message } or Error with .cause.
    if (typeof value.message === 'string' && value.message) {
      return value.code ? `${value.code}: ${value.message}` : value.message
    }
    if (typeof value.error === 'object' && value.error?.message) {
      return `${value.error.code || 'ERROR'}: ${value.error.message}`
    }
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  return String(value)
}

// ── gateway client ──────────────────────────────────────────────────────────

let nextId = 1

function loadToken() {
  if (process.env.RTERM_TOKEN) return process.env.RTERM_TOKEN
  const candidates = [
    join(homedir(), '.gybackend-data', 'access-tokens.json'),
    join(process.cwd(), '.gybackend-data', 'access-tokens.json'),
  ]
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'))
        const first = Array.isArray(parsed) ? parsed[0] : parsed
        if (first && typeof first.token === 'string') return first.token
        if (typeof parsed === 'string') return parsed
      } catch { /* ignore malformed */ }
    }
  }
  return null
}

async function openSocket(url, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined
  if (typeof globalThis.WebSocket === 'function') {
    return await new Promise((resolve, reject) => {
      const ws = new globalThis.WebSocket(url)
      ws.onopen = () => resolve(ws)
      ws.onerror = () => reject(new Error(`Cannot connect to ${url}. Is the backend running? (gybackend)`))
    })
  }
  try {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const WS = require('ws')
    return await new Promise((resolve, reject) => {
      const ws = new WS(url, { headers })
      ws.on('open', () => resolve(ws))
      ws.on('error', () => reject(new Error(`Cannot connect to ${url}. Is the backend running? (gybackend)`)))
    })
  } catch {
    throw new Error('No WebSocket client available. Use Node >= 21 or install the `ws` package.')
  }
}

async function call(url, method, params, token) {
  const ws = await openSocket(url, token)
  const id = String(nextId++)
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close() } catch { /* ignore */ }
      reject(new Error(`Timeout calling ${method} (60s)`))
    }, 60_000)
    const onMessage = (raw) => {
      try {
        const frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
        if (frame.type === 'gateway:response' && frame.id === id) {
          clearTimeout(timer)
          try { ws.close() } catch { /* ignore */ }
          if (frame.ok) resolve(frame.result)
          else reject(frame.error || new Error(`gateway error: ${method}`))
        }
      } catch { /* ignore non-JSON frames */ }
    }
    const onClose = () => {
      clearTimeout(timer)
      reject(new Error('Connection closed before response. Is the backend still running?'))
    }

    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('message', (event) => onMessage(event.data))
      ws.addEventListener('close', onClose)
      ws.addEventListener('error', onClose)
    } else if (typeof ws.on === 'function') {
      ws.on('message', (data) => onMessage(data))
      ws.on('close', onClose)
      ws.on('error', onClose)
    } else {
      ws.onmessage = (event) => onMessage(event.data)
      ws.onclose = onClose
    }

    const payload = { id, method, ...(params !== undefined ? { params } : {}) }
    ws.send(JSON.stringify(payload))
  })
}

/** Client bound to a URL + token, so commands don't repeat them. */
function makeClient(url, token) {
  return {
    call: (method, params) => call(url, method, params, token),
  }
}

// ── output helpers ──────────────────────────────────────────────────────────

function printJson(value) {
  console.log(JSON.stringify(value, null, 2))
}

function fail(message) {
  console.error(`Error: ${errorMessage(message)}`)
  process.exit(1)
}

const HELP = `rterm — command CLI for the RTerm / neuralOS backend gateway

Usage:
  rterm ping                                Liveness check
  rterm version                             Backend version + method count
  rterm methods [--category c] [--prefix p] List gateway RPC methods
  rterm call <method> [json]                Raw JSON-RPC call (params as JSON)
  rterm terminals                           List terminal tabs
  rterm connections                         List saved SSH/WinRM/Serial connections
  rterm open <connection-name>              Open a terminal tab for a saved connection
  rterm close <tabIdOrName>                 Close a terminal tab
  rterm run <tabIdOrName> <command>         Run a command in a terminal tab (waits)
  rterm fleet <tab1,tab2,...> <command>     Run a command on many tabs at once
  rterm sessions                            List chat sessions
  rterm chat <sessionId> <message>          Send a message to the agent (blocking)
  rterm dashboard                           Print the live dashboard state
  rterm metrics [--format prometheus]       Host metrics

Options:
  --url ws://host:port    Gateway URL (default ${DEFAULT_URL}, env RTERM_URL)
  --token <token>         Access token (env RTERM_TOKEN; non-localhost requires one)

Environment:
  RTERM_URL, RTERM_HOST, RTERM_PORT, RTERM_TOKEN
`

// ── command helpers ─────────────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

function stripAnsi(text) {
  return text.replace(ANSI_RE, '')
}

/**
 * Resolve a saved connection by name or id across ssh/winrm/serial and build
 * an inline terminal config the backend accepts (createTab does NOT resolve
 * saved-connection names itself).
 */
function connectionToConfig(entry, kind) {
  if (kind === 'ssh') {
    return {
      type: 'ssh',
      host: entry.host,
      port: entry.port ?? 22,
      username: entry.username,
      ...(entry.authMethod === 'privateKey'
        ? { privateKey: entry.privateKey }
        : { password: entry.password }),
      ...(entry.algorithmsPreset ? { algorithmsPreset: entry.algorithmsPreset } : {}),
      ...(entry.termType ? { termType: entry.termType } : {}),
    }
  }
  if (kind === 'winrm') {
    return {
      type: 'winrm',
      host: entry.host,
      port: entry.port ?? 5985,
      username: entry.username,
      password: entry.password,
      ...(entry.transport ? { transport: entry.transport } : {}),
    }
  }
  return {
    type: 'serial',
    path: entry.path,
    baudRate: entry.baudRate ?? 9600,
  }
}

async function fetchConnections(client) {
  const settings = await client.call('settings:get', {})
  const conns = settings?.connections || {}
  return {
    ssh: Array.isArray(conns.ssh) ? conns.ssh : [],
    winrm: Array.isArray(conns.winrm) ? conns.winrm : [],
    serial: Array.isArray(conns.serial) ? conns.serial : [],
  }
}

async function resolveConnection(client, nameOrId) {
  const { ssh, winrm, serial } = await fetchConnections(client)
  const pools = [['ssh', ssh], ['winrm', winrm], ['serial', serial]]
  for (const [kind, list] of pools) {
    const hit = list.find((c) => c.id === nameOrId || c.name === nameOrId)
    if (hit) return { kind, entry: hit }
  }
  return null
}

/** Resolve a tab id-or-name to a real tab id via terminal:list. */
async function resolveTabId(client, tabIdOrName) {
  const result = await client.call('terminal:list', {})
  const terminals = result?.terminals || []
  const hit = terminals.find((t) => t.id === tabIdOrName || t.title === tabIdOrName)
  return hit?.id || null
}

/**
 * Run a command in a tab via write + buffer-delta polling; returns output.
 * Validates the tab exists first — the gateway silently returns empty output
 * for unknown terminal ids, which would otherwise look like success.
 */
async function runInTab(client, tabIdOrName, commandText) {
  const tabId = await resolveTabId(client, tabIdOrName)
  if (!tabId) {
    const result = await client.call('terminal:list', {})
    const known = (result?.terminals || []).map((t) => `${t.id} (${t.title})`).join(', ')
    throw new Error(`No terminal tab "${tabIdOrName}". Open tabs: ${known || '(none)'}`)
  }
  const before = await client.call('terminal:getBufferDelta', { terminalId: tabId, fromOffset: 0 })
  const startOffset = Number(before?.offset ?? 0)
  await client.call('terminal:write', { terminalId: tabId, data: `${commandText}\n` })
  let output = ''
  let lastOffset = startOffset
  let stable = 0
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    const delta = await client.call('terminal:getBufferDelta', { terminalId: tabId, fromOffset: lastOffset })
    const data = typeof delta?.data === 'string' ? delta.data : ''
    const offset = Number(delta?.offset ?? lastOffset)
    if (data) output += data
    if (offset === lastOffset && !data) {
      stable += 1
      if (stable >= 3) break
    } else {
      stable = 0
    }
    lastOffset = offset
  }
  return stripAnsi(output).trimEnd()
}

// ── commands ────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2)
  const { positional, flags } = parseArgs(argv)
  const url = (typeof flags.url === 'string' && flags.url) || DEFAULT_URL
  const token = (typeof flags.token === 'string' && flags.token) || loadToken()
  const command = positional[0]

  if (!command || command === 'help' || flags.help) {
    console.log(HELP)
    process.exit(0)
  }

  const client = makeClient(url, token)

  try {
    switch (command) {
      case 'ping': {
        printJson(await client.call('gateway:ping'))
        break
      }
      case 'version': {
        const result = await client.call('gateway:describe')
        printJson({ version: result.version, methodCount: result.count, categories: result.categories })
        break
      }
      case 'methods': {
        const params = {}
        if (typeof flags.category === 'string') params.category = flags.category
        if (typeof flags.prefix === 'string') params.prefix = flags.prefix
        const result = await client.call('gateway:describe', params)
        printJson(result.methods)
        break
      }
      case 'call': {
        const method = positional[1]
        if (!method) fail('call needs a method name: rterm call <method> [json-params]')
        let params
        if (positional[2]) {
          try { params = JSON.parse(positional[2]) } catch { fail('params must be valid JSON') }
        }
        printJson(await client.call(method, params))
        break
      }
      case 'terminals': {
        printJson(await client.call('terminal:list'))
        break
      }
      case 'connections': {
        const { ssh, winrm, serial } = await fetchConnections(client)
        const out = { connections: [] }
        for (const kind of ['ssh', 'winrm', 'serial']) {
          const list = kind === 'ssh' ? ssh : kind === 'winrm' ? winrm : serial
          for (const c of list) {
            out.connections.push({
              kind,
              name: c.name,
              id: c.id,
              host: c.host || c.path || '',
              port: c.port ?? c.baudRate ?? '',
              username: c.username || '',
            })
          }
        }
        printJson(out)
        break
      }
      case 'open': {
        const name = positional[1]
        if (!name) fail('open needs a saved connection name: rterm open <name>')
        const found = await resolveConnection(client, name)
        if (!found) {
          const { ssh, winrm, serial } = await fetchConnections(client)
          const names = [...ssh, ...winrm, ...serial].map((c) => c.name).filter(Boolean)
          fail(`No saved connection named "${name}". Available: ${names.join(', ') || '(none)'}`)
        }
        const config = connectionToConfig(found.entry, found.kind)
        const result = await client.call('terminal:createTab', { config })
        printJson({ opened: name, kind: found.kind, ...result })
        break
      }
      case 'close': {
        const tab = positional[1]
        if (!tab) fail('close needs a tab id or name: rterm close <tabIdOrName>')
        const tabId = (await resolveTabId(client, tab)) || tab
        printJson(await client.call('terminal:kill', { terminalId: tabId }))
        break
      }
      case 'run': {
        const tab = positional[1]
        const commandText = positional.slice(2).join(' ')
        if (!tab || !commandText) fail('run needs: rterm run <tabIdOrName> <command>')
        console.log(await runInTab(client, tab, commandText))
        break
      }
      case 'fleet': {
        const tabs = (positional[1] || '').split(',').map((s) => s.trim()).filter(Boolean)
        const commandText = positional.slice(2).join(' ')
        if (tabs.length === 0 || !commandText) fail('fleet needs: rterm fleet <tab1,tab2,...> <command>')
        for (const tab of tabs) {
          console.log(`── ${tab} ──`)
          try {
            console.log(await runInTab(client, tab, commandText))
          } catch (error) {
            console.log(`Error: ${errorMessage(error)}`)
            process.exitCode = 2
          }
        }
        break
      }
      case 'sessions': {
        printJson(await client.call('session:list'))
        break
      }
      case 'chat': {
        const sessionId = positional[1]
        const message = positional.slice(2).join(' ')
        if (!sessionId || !message) fail('chat needs: rterm chat <sessionId> <message>')
        printJson(await client.call('agent:startTask', { sessionId, userInput: message }))
        break
      }
      case 'dashboard': {
        printJson(await client.call('observability:liveDashboardState'))
        break
      }
      case 'metrics': {
        const format = flags.format === 'prometheus' ? 'prometheus' : 'summary'
        const result = await client.call('observability:metricsPrometheus', { format })
        console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
        break
      }
      default:
        fail(`Unknown command: ${command}. Run "rterm help".`)
    }
  } catch (error) {
    fail(error)
  }
}

main()
