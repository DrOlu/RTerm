import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { GatewayClient } from './gateway-client'

export type CliMode = 'tui' | 'run' | 'hook'

export interface CliOptions {
  url?: string
  token?: string
  mode: CliMode
  message?: string
  sessionId?: string
  timeoutMs: number
  help: boolean
}

export function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: 'tui',
    timeoutMs: 3000,
    help: false,
  }
  const messageTokens: string[] = []
  let modeResolved = false

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const next = argv[i + 1]

    if (token === '--') {
      messageTokens.push(...argv.slice(i + 1))
      break
    }
    if (token === '--help' || token === '-h') {
      options.help = true
      continue
    }
    if (token === '--url' && next) {
      options.url = normalizeWsUrl(next)
      i += 1
      continue
    }
    if ((token === '--sessionid' || token === '--session-id' || token === '--sessionId') && next) {
      options.sessionId = next
      i += 1
      continue
    }
    if (token === '--token' && next) {
      options.token = next.trim() || undefined
      i += 1
      continue
    }
    if (token === '--timeout' && next) {
      const parsed = Number(next)
      if (Number.isInteger(parsed) && parsed > 250) {
        options.timeoutMs = parsed
      }
      i += 1
      continue
    }

    if (!modeResolved && (token === 'run' || token === 'hook')) {
      options.mode = token
      modeResolved = true
      continue
    }

    messageTokens.push(token)
  }

  const message = messageTokens.join(' ').trim()
  if (message) {
    options.message = message
  }

  return options
}

export function printCliHelp(): void {
  const lines = [
    'RTerm TUI',
    '',
    'Usage:',
    '  gyll [--url 127.0.0.1:17888] [--timeout 3000] [--sessionid <id>]',
    '  gyll [--url 127.0.0.1:17888] [--token <access_token>] [--timeout 3000] "message"',
    '  gyll run [--url 127.0.0.1:17888] [--token <access_token>] [--timeout 3000] "message"',
    '  gyll hook [--url 127.0.0.1:17888] [--token <access_token>] [--timeout 3000] "message"',
    '',
    'Commands:',
    '  run         Send one message and stream output in terminal, then exit',
    '  hook        Send one message asynchronously, then exit immediately',
    '  (default)   Start interactive TUI mode',
    '',
    'Options:',
    '  --url        Gateway websocket URL (ip:port or ws://ip:port)',
    '  --token      Access token for non-local websocket gateways',
    '  --sessionid  Prefer this session id when entering TUI',
    '  --timeout  Probe/connect timeout in milliseconds (default: 3000)',
    '  --help,-h  Show this message',
  ]

  output.write(lines.join('\n') + '\n')
}

export async function resolveGatewayConnection(options: CliOptions): Promise<{ client: GatewayClient; url: string }> {
  const candidates = buildProbeCandidates(options)

  for (const candidate of candidates) {
    const connected = await tryConnect(candidate, options.timeoutMs, options.token)
    if (connected) return connected
  }

  const defaultUrl = candidates[0]

  while (true) {
    const manual = await promptForUrl(defaultUrl)
    const connected = await tryConnect(manual, options.timeoutMs, options.token)
    if (connected) return connected
    output.write(`Unable to connect to ${manual}. Please try again.\n`)
  }
}

async function promptForUrl(defaultUrl: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error(`Unable to auto-connect to gateway. Please rerun with --url (tried ${defaultUrl}).`)
  }

  const rl = readline.createInterface({ input, output })
  const answer = await rl.question(`Gateway websocket URL [${defaultUrl}]: `)
  rl.close()

  if (!answer.trim()) return defaultUrl
  return normalizeWsUrl(answer.trim())
}

function buildProbeCandidates(options: CliOptions): string[] {
  if (options.url) return [normalizeWsUrl(options.url)]

  const ports = new Set<number>()
  ports.add(17888)

  const envPort = parsePort(process.env.GYSHELL_WS_PORT)
  if (envPort) ports.add(envPort)

  const backendEnvPort = parsePort(process.env.GYBACKEND_WS_PORT)
  if (backendEnvPort) ports.add(backendEnvPort)
  const hosts = ['127.0.0.1', 'localhost']
  const urls: string[] = []

  for (const port of ports) {
    for (const host of hosts) {
      urls.push(normalizeWsUrl(`ws://${host}:${port}`))
    }
  }

  return urls
}

function parsePort(raw: string | undefined): number | null {
  if (!raw) return null
  const value = Number(raw)
  if (!Number.isInteger(value)) return null
  if (value < 1 || value > 65535) return null
  return value
}

async function tryConnect(
  url: string,
  timeoutMs: number,
  accessToken?: string
): Promise<{ client: GatewayClient; url: string } | null> {
  const client = new GatewayClient(url, accessToken)
  try {
    await client.connect(timeoutMs)
    await client.ping()
    return { client, url }
  } catch {
    client.close()
    return null
  }
}

function normalizeWsUrl(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('ws://') || value.startsWith('wss://')) return value
  return `ws://${value}`
}
