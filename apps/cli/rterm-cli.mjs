#!/usr/bin/env node
/**
 * rterm-cli — a `gyll`-style command CLI for the RTerm / neuralOS backend.
 *
 * Speaks the backend's WebSocket JSON-RPC gateway natively (ws://host:17888):
 *   rterm ping
 *   rterm methods [--category cat] [--prefix p]
 *   rterm call <method> [json-params]
 *   rterm terminals
 *   rterm open <saved-connection-name>
 *   rterm run <tabIdOrName> <command>
 *   rterm chat <sessionId> <message>       (blocking; prints the final answer)
 *   rterm sessions
 *   rterm dashboard
 *   rterm metrics [--format prometheus|summary]
 *   rterm fleet <tab1,tab2> <command>
 *
 * Zero runtime dependencies: uses Node's built-in WebSocket (Node >= 21) and
 * falls back to the `ws` package from the backend install when present.
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

async function openSocket(url) {
  // Node >= 21 ships a native WebSocket client.
  if (typeof globalThis.WebSocket === 'function') {
    return await new Promise((resolve, reject) => {
      const ws = new globalThis.WebSocket(url)
      ws.onopen = () => resolve(ws)
      ws.onerror = () => reject(new Error(`Cannot connect to ${url}. Is the backend running? (gybackend)`))
    })
  }
  // Fallback: the `ws` package (present in a backend checkout/install).
  try {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const WS = require('ws')
    return await new Promise((resolve, reject) => {
      const ws = new WS(url)
      ws.on('open', () => resolve(ws))
      ws.on('error', () => reject(new Error(`Cannot connect to ${url}. Is the backend running? (gybackend)`)))
    })
  } catch {
    throw new Error('No WebSocket client available. Use Node >= 21 or install the `ws` package.')
  }
}

async function call(url, method, params) {
  const ws = await openSocket(url)
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
          else reject(new Error(frame.error || `gateway error: ${method}`))
        }
      } catch { /* ignore non-JSON frames */ }
    }
    const onClose = () => { clearTimeout(timer); reject(new Error('Connection closed before response.')) }

    // Normalize the native WebSocket (addEventListener) and the `ws` package
    // (on/on('message')) behind one interface.
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

// ── output helpers ──────────────────────────────────────────────────────────

function printJson(value) {
  console.log(JSON.stringify(value, null, 2))
}

function fail(message) {
  console.error(`Error: ${message}`)
  process.exit(1)
}

const HELP = `rterm — command CLI for the RTerm / neuralOS backend gateway

Usage:
  rterm ping                                Liveness check
  rterm methods [--category c] [--prefix p] List gateway RPC methods
  rterm call <method> [json]                Raw JSON-RPC call (params as JSON)
  rterm terminals                           List terminal tabs
  rterm open <connection-name>              Open a terminal tab for a saved connection
  rterm close <tabIdOrName>                 Close a terminal tab
  rterm run <tabIdOrName> <command>         Run a command in a terminal tab (waits)
  rterm fleet <tab1,tab2,...> <command>     Run a command on many tabs at once
  rterm sessions                            List chat sessions
  rterm chat <sessionId> <message>          Send a message to the agent (blocking)
  rterm dashboard                           Print the live dashboard state
  rterm metrics [--format prometheus]       Host metrics
  rterm version                             Backend version + method count

Options:
  --url ws://host:port    Gateway URL (default ${DEFAULT_URL}, env RTERM_URL)
  --token <token>         Access token (env RTERM_TOKEN; non-localhost requires one)

Environment:
  RTERM_URL, RTERM_HOST, RTERM_PORT, RTERM_TOKEN
`

// ── commands ────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2)
  const { positional, flags } = parseArgs(argv)
  const url = (typeof flags.url === 'string' && flags.url) || DEFAULT_URL
  const command = positional[0]

  if (!command || command === 'help' || flags.help) {
    console.log(HELP)
    process.exit(0)
  }

  try {
    switch (command) {
      case 'ping': {
        const result = await call(url, 'gateway:ping')
        printJson(result)
        break
      }
      case 'version': {
        const result = await call(url, 'gateway:describe')
        printJson({ version: result.version, methodCount: result.count, categories: result.categories })
        break
      }
      case 'methods': {
        const params = {}
        if (typeof flags.category === 'string') params.category = flags.category
        if (typeof flags.prefix === 'string') params.prefix = flags.prefix
        const result = await call(url, 'gateway:describe', params)
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
        const result = await call(url, method, params)
        printJson(result)
        break
      }
      case 'terminals': {
        const result = await call(url, 'terminal:list')
        printJson(result)
        break
      }
      case 'open': {
        const name = positional[1]
        if (!name) fail('open needs a saved connection name: rterm open <name>')
        const result = await call(url, 'terminal:createTab', { config: { savedConnectionName: name } })
        printJson(result)
        break
      }
      case 'close': {
        const tab = positional[1]
        if (!tab) fail('close needs a tab id or name: rterm close <tabIdOrName>')
        const result = await call(url, 'terminal:kill', { terminalId: tab })
        printJson(result)
        break
      }
      case 'run': {
        const tab = positional[1]
        const commandText = positional.slice(2).join(' ')
        if (!tab || !commandText) fail('run needs: rterm run <tabIdOrName> <command>')
        // The gateway's terminal surface is write + buffer-delta: send the
        // command with a newline, then poll the buffer until it settles.
        const before = await call(url, 'terminal:getBufferDelta', { terminalId: tab, fromOffset: 0 })
        const startOffset = Number(before?.offset ?? 0)
        await call(url, 'terminal:write', { terminalId: tab, data: `${commandText}\n` })
        let output = ''
        let lastOffset = startOffset
        let stable = 0
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 400))
          const delta = await call(url, 'terminal:getBufferDelta', { terminalId: tab, fromOffset: lastOffset })
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
        console.log(output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trimEnd())
        break
      }
      case 'fleet': {
        const tabs = (positional[1] || '').split(',').map((s) => s.trim()).filter(Boolean)
        const commandText = positional.slice(2).join(' ')
        if (tabs.length === 0 || !commandText) fail('fleet needs: rterm fleet <tab1,tab2,...> <command>')
        for (const tab of tabs) {
          console.log(`── ${tab} ──`)
          try {
            const before = await call(url, 'terminal:getBufferDelta', { terminalId: tab, fromOffset: 0 })
            const startOffset = Number(before?.offset ?? 0)
            await call(url, 'terminal:write', { terminalId: tab, data: `${commandText}\n` })
            let output = ''
            let lastOffset = startOffset
            let stable = 0
            const deadline = Date.now() + 30_000
            while (Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 400))
              const delta = await call(url, 'terminal:getBufferDelta', { terminalId: tab, fromOffset: lastOffset })
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
            console.log(output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trimEnd())
          } catch (error) {
            console.log(`Error: ${error instanceof Error ? error.message : String(error)}`)
            process.exitCode = 2
          }
        }
        break
      }
      case 'sessions': {
        const result = await call(url, 'session:list')
        printJson(result)
        break
      }
      case 'chat': {
        const sessionId = positional[1]
        const message = positional.slice(2).join(' ')
        if (!sessionId || !message) fail('chat needs: rterm chat <sessionId> <message>')
        const result = await call(url, 'agent:startTask', { sessionId, userInput: message })
        printJson(result)
        break
      }
      case 'dashboard': {
        const result = await call(url, 'observability:liveDashboardState')
        printJson(result)
        break
      }
      case 'metrics': {
        const format = flags.format === 'prometheus' ? 'prometheus' : 'summary'
        const result = await call(url, 'observability:metricsPrometheus', { format })
        console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
        break
      }
      default:
        fail(`Unknown command: ${command}. Run "rterm help".`)
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

main()
