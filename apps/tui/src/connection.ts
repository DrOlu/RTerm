import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { GatewayClient } from './gateway-client'

export interface CliOptions {
  url?: string
  host?: string
  port?: number
  timeoutMs: number
  help: boolean
}

export function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    timeoutMs: 3000,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const next = argv[i + 1]

    if (token === '--help' || token === '-h') {
      options.help = true
      continue
    }
    if (token === '--url' && next) {
      options.url = normalizeWsUrl(next)
      i += 1
      continue
    }
    if (token === '--host' && next) {
      options.host = next
      i += 1
      continue
    }
    if (token === '--port' && next) {
      const parsed = Number(next)
      if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
        options.port = parsed
      }
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
  }

  if (!options.url && (options.host || options.port)) {
    const host = options.host ?? '127.0.0.1'
    const port = options.port ?? 17888
    options.url = `ws://${host}:${port}`
  }

  return options
}

export function printCliHelp(): void {
  const lines = [
    'GyShell TUI',
    '',
    'Usage:',
    '  gyshell-tui [--url ws://127.0.0.1:17888] [--host 127.0.0.1 --port 17888] [--timeout 3000]',
    '',
    'Options:',
    '  --url      Full websocket gateway URL',
    '  --host     Gateway host when --url is not provided',
    '  --port     Gateway port when --url is not provided',
    '  --timeout  Probe/connect timeout in milliseconds (default: 3000)',
    '  --help     Show this message',
  ]

  output.write(lines.join('\n') + '\n')
}

export async function resolveGatewayConnection(options: CliOptions): Promise<{ client: GatewayClient; url: string }> {
  const candidates = buildProbeCandidates(options)

  for (const candidate of candidates) {
    const connected = await tryConnect(candidate, options.timeoutMs)
    if (connected) return connected
  }

  const defaultUrl = candidates[0]

  while (true) {
    const manual = await promptForUrl(defaultUrl)
    const connected = await tryConnect(manual, options.timeoutMs)
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

  if (options.port) ports.add(options.port)

  const hosts = options.host ? [options.host] : ['127.0.0.1', 'localhost']
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

async function tryConnect(url: string, timeoutMs: number): Promise<{ client: GatewayClient; url: string } | null> {
  const client = new GatewayClient(url)
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
