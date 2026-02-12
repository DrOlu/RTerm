import { parseCliOptions, printCliHelp, resolveGatewayConnection } from './connection'
import { runTui } from './tui-app'
import type {
  ChatMessage,
  GatewayProfileSummary,
  GatewaySessionSnapshot,
  GatewaySessionSummary,
  GatewayTerminalSummary,
} from './protocol'

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2))

  if (options.help) {
    printCliHelp()
    return
  }

  const { client, url } = await resolveGatewayConnection(options)

  try {
    const terminalsPayload = await client.request<{ terminals: GatewayTerminalSummary[] }>('terminal:list', {})
    const terminals = terminalsPayload.terminals ?? []
    if (terminals.length === 0) {
      throw new Error('No terminal is available on backend. Start gybackend with terminal bootstrap enabled.')
    }

    const initialTerminalId = terminals[0].id

    const profilesData = await safeRequestProfiles(client)
    const sessionSummaries = await safeRequestSessionSummaries(client)
    const initialSession = await resolveInitialSession(client, terminals, sessionSummaries, initialTerminalId)

    await runTui(client, {
      endpoint: url,
      terminals,
      profiles: profilesData.profiles,
      activeProfileId: profilesData.activeProfileId,
      initialSessionId: initialSession.id,
      initialTerminalId: initialSession.terminalId,
      initialSessionTitle: initialSession.title,
      initialMessages: initialSession.messages,
      restoredSessionCount: sessionSummaries.length,
      recoveredSessions: sessionSummaries,
    })
  } finally {
    client.close()
  }
}

async function safeRequestProfiles(client: { request: <T>(method: string, params?: Record<string, unknown>) => Promise<T> }) {
  try {
    const payload = await client.request<{ activeProfileId: string; profiles: GatewayProfileSummary[] }>('models:getProfiles', {})
    return {
      activeProfileId: payload.activeProfileId,
      profiles: payload.profiles ?? [],
    }
  } catch {
    return {
      activeProfileId: '',
      profiles: [] as GatewayProfileSummary[],
    }
  }
}

async function safeRequestSessionSummaries(
  client: { request: <T>(method: string, params?: Record<string, unknown>) => Promise<T> },
): Promise<GatewaySessionSummary[]> {
  try {
    const payload = await client.request<{ sessions: GatewaySessionSummary[] }>('session:list', {})
    return payload.sessions ?? []
  } catch {
    return []
  }
}

async function resolveInitialSession(
  client: { request: <T>(method: string, params?: Record<string, unknown>) => Promise<T> },
  terminals: GatewayTerminalSummary[],
  sessions: GatewaySessionSummary[],
  fallbackTerminalId: string,
): Promise<{ id: string; terminalId: string; title: string; messages: ChatMessage[] }> {
  if (sessions.length === 0) {
    const created = await createNewSession(client, fallbackTerminalId)
    return {
      id: created.sessionId,
      terminalId: fallbackTerminalId,
      title: 'New Chat',
      messages: [],
    }
  }

  const preferred = sessions[0]
  try {
    const payload = await client.request<{ session: GatewaySessionSnapshot }>('session:get', {
      sessionId: preferred.id,
    })
    const restored = payload.session
    const terminalId = resolveTerminalId(restored.boundTerminalId, terminals, fallbackTerminalId)
    return {
      id: restored.id,
      terminalId,
      title: restored.title || preferred.title,
      messages: restored.messages ?? [],
    }
  } catch {
    const created = await createNewSession(client, fallbackTerminalId)
    return {
      id: created.sessionId,
      terminalId: fallbackTerminalId,
      title: 'New Chat',
      messages: [],
    }
  }
}

async function createNewSession(
  client: { request: <T>(method: string, params?: Record<string, unknown>) => Promise<T> },
  terminalId: string,
): Promise<{ sessionId: string }> {
  return await client.request<{ sessionId: string }>('gateway:createSession', { terminalId })
}

function resolveTerminalId(
  preferredTerminalId: string | undefined,
  terminals: GatewayTerminalSummary[],
  fallbackTerminalId: string,
): string {
  if (!preferredTerminalId) return fallbackTerminalId
  const exists = terminals.some((terminal) => terminal.id === preferredTerminalId)
  return exists ? preferredTerminalId : fallbackTerminalId
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`GyShell TUI failed: ${message}\n`)
  process.exitCode = 1
})
