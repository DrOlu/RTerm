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
 *   rterm chat                        Interactive persistent chat (REPL):
 *                                     streaming replies, session resume,
 *                                     command approvals, slash commands.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'

const DEFAULT_HOST = process.env.RTERM_HOST || '127.0.0.1'
const DEFAULT_PORT = Number(process.env.RTERM_PORT || 17888)
const DEFAULT_URL = process.env.RTERM_URL || `ws://${DEFAULT_HOST}:${DEFAULT_PORT}`
const STATE_DIR = join(homedir(), '.rterm-cli')
const STATE_FILE = join(STATE_DIR, 'chat-state.json')

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

/**
 * Append the token as an `access_token` query parameter. The gateway accepts
 * the token from the Authorization header OR this query param; the query param
 * works on every WebSocket client (native WS ignores constructor options on
 * some runtimes, and browsers cannot send custom headers at all).
 */
function urlWithToken(url, token) {
  if (!token) return url
  try {
    const u = new URL(url)
    if (!u.searchParams.has('access_token')) u.searchParams.set('access_token', token)
    return u.toString()
  } catch {
    return url
  }
}

async function openSocket(url, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined
  if (typeof globalThis.WebSocket === 'function') {
    return await new Promise((resolve, reject) => {
      // Pass the token BOTH ways: as a query param (always works) and try the
      // options object (native WebSocket in Node >= 22 forwards extra options
      // to undici and sends the header; browsers ignore it harmlessly).
      const ws = new globalThis.WebSocket(urlWithToken(url, token), headers ? { headers } : undefined)
      ws.onopen = () => resolve(ws)
      ws.onerror = () => reject(new Error(`Cannot connect to ${url}. Is the backend running? (gybackend)`))
    })
  }
  try {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const WS = require('ws')
    return await new Promise((resolve, reject) => {
      const ws = new WS(urlWithToken(url, token), { headers })
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

// ── persistent (multiplexed) client for interactive chat ────────────────────

/**
 * One long-lived WebSocket; JSON-RPC calls are multiplexed by id and every
 * gateway event frame is fanned out to registered listeners. This is what
 * makes the interactive chat possible: we LISTEN while we TALK.
 */
class PersistentClient {
  constructor(url, token) {
    this.url = url
    this.token = token
    this.ws = null
    this.pending = new Map() // id -> { resolve, reject }
    this.eventListeners = new Set() // (frame) => void
  }

  async connect() {
    this.ws = await openSocket(this.url, this.token)
    const wire = (raw) => {
      let frame
      try {
        frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
      } catch { return }
      if (frame.type === 'gateway:response' && frame.id !== undefined) {
        const p = this.pending.get(String(frame.id))
        if (p) {
          this.pending.delete(String(frame.id))
          if (frame.ok) p.resolve(frame.result)
          else p.reject(frame.error || new Error('gateway error'))
        }
        return
      }
      if (frame.type === 'gateway:event' || frame.type === 'gateway:ui-update') {
        for (const fn of this.eventListeners) {
          try { fn(frame) } catch { /* listener errors never kill the socket */ }
        }
      }
    }
    if (typeof this.ws.addEventListener === 'function') {
      this.ws.addEventListener('message', (e) => wire(e.data))
      this.ws.addEventListener('close', () => this.onClosed())
    } else if (typeof this.ws.on === 'function') {
      this.ws.on('message', (d) => wire(d))
      this.ws.on('close', () => this.onClosed())
    } else {
      this.ws.onmessage = (e) => wire(e.data)
      this.ws.onclose = () => this.onClosed()
    }
  }

  onClosed() {
    // Reject everything in flight; the REPL surfaces a clear message.
    for (const [, p] of this.pending) {
      p.reject(new Error('Connection closed. Is the backend still running?'))
    }
    this.pending.clear()
  }

  get connected() {
    return this.ws && this.ws.readyState === 1
  }

  async reconnect() {
    try { this.ws?.close?.() } catch { /* ignore */ }
    await this.connect()
  }

  onEvent(fn) {
    this.eventListeners.add(fn)
    return () => this.eventListeners.delete(fn)
  }

  call(method, params, timeoutMs = 60_000) {
    if (!this.connected) throw new Error('Not connected.')
    const id = String(nextId++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timeout calling ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }))
    })
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

const C = process.stdout.isTTY ? {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
} : {
  dim: (s) => s, bold: (s) => s, cyan: (s) => s,
  yellow: (s) => s, red: (s) => s, green: (s) => s,
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
  rterm chat                                Interactive persistent chat (REPL)
  rterm chat <sessionId> <message>          Send a message to the agent (blocking)
  rterm dashboard                           Print the live dashboard state
  rterm metrics [--format prometheus]       Host metrics

Interactive chat slash commands:
  /new                    Start a fresh session
  /sessions               List sessions (pick one to resume)
  /rename <title>         Rename the current session
  /branch                 Branch from the last assistant message
  /export [--simple]      Export this session as markdown
  /search <query>         Full-text search across ALL sessions
  /stop                   Stop the running agent task
  /verbose                Toggle raw event display
  /help                   This list
  /exit                   Leave the chat (session is kept server-side)

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

// ── chat state (session resume) ─────────────────────────────────────────────

function loadChatState() {
  try {
    if (existsSync(STATE_FILE)) {
      const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
      if (parsed && typeof parsed === 'object') return parsed
    }
  } catch { /* corrupted state → start fresh */ }
  return {}
}

function saveChatState(patch) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const next = { ...loadChatState(), ...patch }
    writeFileSync(STATE_FILE, JSON.stringify(next, null, 2))
  } catch { /* best-effort */ }
}

// ── interactive chat ────────────────────────────────────────────────────────

/** Extract {sessionId, event} from a gateway:event frame (null otherwise). */
function extractAgentEvent(frame) {
  if (frame?.type !== 'gateway:event') return null
  const p = frame.payload
  if (p?.type !== 'agent:event') return null
  if (!p.payload || typeof p.payload !== 'object') return null
  return { sessionId: p.sessionId, event: p.payload }
}

function shortId(id) {
  return typeof id === 'string' && id.length > 10 ? `${id.slice(0, 8)}…` : String(id)
}

class InteractiveChat {
  constructor(client, flags) {
    this.client = client
    this.flags = flags || {}
    this.sessionId = null
    this.verbose = this.flags.verbose === true
    this.turnActive = false
    this.turnResolve = null
    this.currentSayId = null
    this.sayOpen = false
    this.lastAssistantMessageId = null
    this.unsubscribe = null
    this.rl = null
  }

  async start() {
    const state = loadChatState()
    const requested = typeof this.flags.session === 'string' && this.flags.session
      ? this.flags.session
      : (state.lastSessionId || null)

    if (requested) {
      const ok = await this.tryResume(requested)
      if (!ok) console.log(C.dim(`(saved session ${shortId(requested)} no longer exists — starting fresh)`))
    }
    if (!this.sessionId) {
      await this.newSession()
    }

    this.unsubscribe = this.client.onEvent((frame) => this.handleFrame(frame))

    console.log(C.dim(`Connected to ${this.client.url} — session ${shortId(this.sessionId)}`))
    console.log(C.dim('Type a message, or /help for commands. /exit to leave.\n'))
    await this.printHistory()
    await this.repl()
  }

  async tryResume(sessionId) {
    try {
      const result = await this.client.call('session:get', { sessionId })
      if (result?.session?.id || result?.session?.sessionId) {
        this.sessionId = sessionId
        return true
      }
      return false
    } catch {
      return false
    }
  }

  async newSession() {
    const result = await this.client.call('gateway:createSession')
    this.sessionId = result?.sessionId
    if (!this.sessionId) throw new Error('gateway:createSession returned no sessionId')
    saveChatState({ lastSessionId: this.sessionId, lastUrl: this.client.url })
  }

  async switchSession(sessionId) {
    this.sessionId = sessionId
    saveChatState({ lastSessionId: sessionId, lastUrl: this.client.url })
    console.log(C.dim(`\n── switched to session ${shortId(sessionId)} ──`))
    await this.printHistory()
  }

  async printHistory() {
    let messages = []
    try {
      messages = await this.client.call('agent:getUiMessages', { id: this.sessionId })
      if (!Array.isArray(messages)) messages = []
    } catch {
      return // history bridge unavailable — fine on a fresh session
    }
    if (messages.length === 0) {
      console.log(C.dim('(new session — no history yet)'))
      return
    }
    console.log(C.dim(`── resuming (${messages.length} messages) ──`))
    for (const m of messages) {
      const role = m.role === 'user' ? 'you' : m.role === 'assistant' ? 'assistant' : m.role
      const text = typeof m.content === 'string' ? m.content : ''
      if (!text.trim()) continue
      if (m.streaming) continue // never persisted as streaming in practice
      console.log(`${C.bold(C.cyan(role))}> ${text.length > 2000 ? `${text.slice(0, 2000)}…` : text}`)
    }
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.id)
    this.lastAssistantMessageId = lastAssistant?.id || null
    console.log(C.dim('── end of history ──\n'))
  }

  handleFrame(frame) {
    const extracted = extractAgentEvent(frame)
    if (!extracted || extracted.sessionId !== this.sessionId) return
    const ev = extracted.event
    if (this.verbose) {
      console.log(C.dim(`  [event] ${JSON.stringify(ev).slice(0, 300)}`))
    }
    switch (ev.type) {
      case 'say': {
        this.renderSay(ev)
        break
      }
      case 'user_input':
        break // we echo input locally
      case 'command_started': {
        this.closeSay()
        console.log(C.dim(`⚙ ${ev.command || ev.toolName || 'running…'}`))
        break
      }
      case 'command_finished': {
        this.closeSay()
        const ok = ev.exitCode === undefined || ev.exitCode === 0
        console.log(C.dim(`⚙ done${ev.exitCode !== undefined ? ` (exit ${ev.exitCode})` : ''}${ok ? '' : ' ✗'}`))
        break
      }
      case 'sub_tool_started': {
        this.closeSay()
        process.stdout.write(C.dim(`· ${ev.title || ev.toolName || 'thinking'} `))
        break
      }
      case 'sub_tool_delta': {
        if (typeof ev.outputDelta === 'string') process.stdout.write(C.dim(ev.outputDelta))
        break
      }
      case 'sub_tool_finished': {
        process.stdout.write('\n')
        break
      }
      case 'alert': {
        this.closeSay()
        console.log(C.yellow(`⚠ ${ev.message || ''}`))
        break
      }
      case 'error': {
        this.closeSay()
        console.log(C.red(`✗ ${ev.message || ev.error || 'agent error'}`))
        break
      }
      case 'command_ask': {
        this.closeSay()
        void this.handleApproval(ev)
        break
      }
      case 'done': {
        this.closeSay()
        this.lastAssistantMessageId = ev.messageId || this.lastAssistantMessageId
        this.finishTurn()
        break
      }
      default:
        break
    }
  }

  renderSay(ev) {
    const delta = typeof ev.content === 'string' ? ev.content : (typeof ev.outputDelta === 'string' ? ev.outputDelta : '')
    if (!delta) return
    const id = ev.messageId || null
    if (id && id !== this.currentSayId) {
      if (this.sayOpen) process.stdout.write('\n\n')
      else if (this.currentSayId !== null) process.stdout.write('\n\n')
      process.stdout.write(`${C.bold(C.cyan('assistant'))}> `)
      this.currentSayId = id
      this.sayOpen = true
    }
    process.stdout.write(delta)
  }

  closeSay() {
    if (this.sayOpen) {
      process.stdout.write('\n')
      this.sayOpen = false
    }
  }

  async handleApproval(ev) {
    const command = ev.command || ''
    const toolName = ev.toolName || 'Command'
    this.closeSay()
    console.log(C.yellow(`\n⏸  approval needed — ${toolName}:`))
    console.log(C.yellow(`   ${command}`))
    // The turn is active (readline paused for the streaming turn) — resume
    // input so the user can actually answer; otherwise this deadlocks.
    this.rl.resume()
    process.stdout.write(C.bold('allow? [y/N] '))
    this.pendingApproval = {
      approvalId: ev.approvalId,
      resolve: async (answer) => {
        const trimmed = (answer || '').trim().toLowerCase()
        const decision = trimmed === 'y' || trimmed === 'yes' ? 'allow' : 'deny'
        try {
          await this.client.call('agent:replyCommandApproval', { approvalId: ev.approvalId, decision })
          console.log(C.dim(decision === 'allow' ? '(allowed)' : '(denied)'))
        } catch (error) {
          console.log(C.red(`approval reply failed: ${errorMessage(error)}`))
        }
        this.pendingApproval = null
      },
    }
  }

  finishTurn() {
    if (this.turnResolve) {
      const r = this.turnResolve
      this.turnResolve = null
      r()
    }
    // EOF arrived while the turn was streaming → shut down now that it's done.
    if (this.stdinClosed && !this.quitting) this.shutdown()
  }

  async runTurn(userInput) {
    this.turnActive = true
    this.currentSayId = null
    this.sayOpen = false
    const turnPromise = new Promise((resolve) => { this.turnResolve = resolve })
    try {
      await this.client.call('agent:startTaskAsync', { sessionId: this.sessionId, userInput })
    } catch (error) {
      this.turnActive = false
      throw error
    }
    await turnPromise
    this.turnActive = false
  }

  async stopTask() {
    try {
      await this.client.call('agent:stopTask', { sessionId: this.sessionId })
      console.log(C.dim('(stop requested)'))
    } catch (error) {
      console.log(C.red(`stop failed: ${errorMessage(error)}`))
    }
  }

  async listSessionsPick() {
    const result = await this.client.call('session:list')
    const sessions = Array.isArray(result?.sessions) ? result.sessions : []
    if (sessions.length === 0) {
      console.log(C.dim('(no sessions)'))
      return
    }
    sessions.forEach((s, i) => {
      const title = s.title || s.name || '(untitled)'
      const when = s.updatedAt || s.lastActivity || ''
      console.log(`  ${String(i + 1).padStart(3)}. ${shortId(s.id)}  ${title}${when ? C.dim(`  ${when}`) : ''}`)
    })
    this.pendingPick = {
      resolve: async (answer) => {
        const idx = Number.parseInt((answer || '').trim(), 10)
        if (Number.isInteger(idx) && idx >= 1 && idx <= sessions.length) {
          await this.switchSession(sessions[idx - 1].id)
        }
        this.pendingPick = null
      },
    }
  }

  async branchFromLast() {
    if (!this.lastAssistantMessageId) {
      console.log(C.dim('(no assistant message to branch from yet)'))
      return
    }
    try {
      const result = await this.client.call('agent:branchFromMessage', {
        sessionId: this.sessionId,
        messageId: this.lastAssistantMessageId,
      })
      const newId = result?.sessionId || result?.id
      if (newId) await this.switchSession(newId)
      else console.log(C.dim('(branch created — see /sessions)'))
    } catch (error) {
      console.log(C.red(`branch failed: ${errorMessage(error)}`))
    }
  }

  async exportSession(mode) {
    try {
      const result = await this.client.call('agent:exportHistory', { sessionId: this.sessionId, mode })
      if (typeof result === 'string') console.log(result)
      else if (typeof result?.content === 'string') console.log(result.content)
      else if (typeof result?.markdown === 'string') console.log(result.markdown)
      else printJson(result)
    } catch (error) {
      console.log(C.red(`export failed: ${errorMessage(error)}`))
    }
  }

  async searchHistory(query) {
    try {
      const result = await this.client.call('history:search', { query })
      printJson(result)
    } catch (error) {
      console.log(C.red(`search failed: ${errorMessage(error)}`))
    }
  }

  async handleSlash(line) {
    const [cmd, ...rest] = line.slice(1).split(/\s+/)
    const arg = rest.join(' ')
    switch ((cmd || '').toLowerCase()) {
      case 'new': {
        await this.newSession()
        console.log(C.dim(`── new session ${shortId(this.sessionId)} ──`))
        return true
      }
      case 'sessions':
        await this.listSessionsPick()
        return true
      case 'rename': {
        if (!arg) { console.log(C.dim('usage: /rename <title>')); return true }
        try {
          await this.client.call('agent:renameSession', { sessionId: this.sessionId, newTitle: arg })
          console.log(C.dim(`renamed to "${arg}"`))
        } catch (error) { console.log(C.red(errorMessage(error))) }
        return true
      }
      case 'branch':
        await this.branchFromLast()
        return true
      case 'export':
        await this.exportSession(this.flags.simple || arg.includes('--simple') ? 'simple' : 'detailed')
        return true
      case 'search':
        if (!arg) { console.log(C.dim('usage: /search <query>')); return true }
        await this.searchHistory(arg)
        return true
      case 'stop':
        await this.stopTask()
        return true
      case 'verbose':
        this.verbose = !this.verbose
        console.log(C.dim(`verbose ${this.verbose ? 'on' : 'off'}`))
        return true
      case 'help':
        console.log(HELP.split('Interactive chat slash commands:')[1]?.split('Options:')[0]?.trim() || 'see /exit')
        return true
      case 'exit':
      case 'quit':
      case 'q':
        return false
      default:
        console.log(C.dim(`unknown command "/${cmd}" — /help for the list`))
        return true
    }
  }

  async repl() {
    // Event-driven readline (NOT readline/promises question()): one 'line'
    // handler dispatches by input state (approval → pick → command/chat).
    // This works identically for a TTY and piped stdin, and never deadlocks.
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${C.bold(C.green('you'))}> ` })
    this.pendingApproval = null
    this.pendingPick = null
    this.quitting = false

    this.rl.on('line', (line) => {
      void this.onLine(line)
    })
    this.rl.on('close', () => {
      // stdin EOF (piped input exhausted, Ctrl-D, or Ctrl-C on some platforms).
      // If a turn is streaming, let it finish first (finishTurn shuts down);
      // otherwise drain gracefully — NEVER process.exit() here, it would race
      // in-flight async line handlers and truncate pending stdout writes.
      this.stdinClosed = true
      if (!this.turnActive) this.shutdown()
    })
    this.rl.prompt()
    // Resolve only when the REPL shuts down — keeps main() alive.
    return new Promise((resolve) => { this.replDone = resolve })
  }

  shutdown() {
    if (this.quitting) return
    this.quitting = true
    this.unsubscribe?.()
    console.log(C.dim(`\nsession ${shortId(this.sessionId)} kept server-side — rerun "rterm chat" to resume.`))
    try { this.rl?.close() } catch { /* ignore */ }
    try { this.client.ws?.close?.() } catch { /* ignore */ }
    this.replDone?.()
  }

  async onLine(line) {
    if (this.quitting) return
    const trimmed = line.trim()

    // 1. Pending approval prompt captures the next line.
    if (this.pendingApproval) {
      const resolver = this.pendingApproval.resolve
      await resolver(trimmed)
      this.rl.prompt()
      return
    }
    // 2. Pending session-pick prompt captures the next line.
    if (this.pendingPick) {
      const resolver = this.pendingPick.resolve
      await resolver(trimmed)
      this.rl.prompt()
      return
    }
    // 3. Slash commands.
    if (trimmed.startsWith('/')) {
      const keepGoing = await this.handleSlash(trimmed)
      if (!keepGoing) {
        this.shutdown()
        return
      }
      this.rl.prompt()
      return
    }
    // 4. Empty line → just re-prompt.
    if (!trimmed) {
      this.rl.prompt()
      return
    }
    // 5. A chat turn. The prompt is suppressed while the agent streams;
    //    the 'done' event re-prompts via finishTurn().
    if (this.turnActive) {
      console.log(C.dim('(agent is still running — /stop to interrupt)'))
      this.rl.prompt()
      return
    }
    this.rl.pause()
    try {
      await this.runTurn(trimmed)
    } catch (error) {
      console.log(C.red(`Error: ${errorMessage(error)}`))
      if (!this.client.connected) {
        try {
          await this.client.reconnect()
          this.unsubscribe?.()
          this.unsubscribe = this.client.onEvent((frame) => this.handleFrame(frame))
          console.log(C.dim('reconnected.'))
        } catch {
          console.log(C.red('reconnect failed — exiting.'))
          this.quitting = true
          this.rl.close()
          process.exit(1)
        }
      }
    }
    this.rl.resume()
    this.rl.prompt()
  }
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
        if (!sessionId) {
          // Interactive persistent chat (the desktop-style experience).
          // chat.start() resolves only when the REPL shuts down.
          const pclient = new PersistentClient(url, token)
          await pclient.connect()
          const chat = new InteractiveChat(pclient, flags)
          await chat.start()
          process.exit(0)
        }
        if (!message) fail('chat needs: rterm chat <sessionId> <message>  (or "rterm chat" for interactive mode)')
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
