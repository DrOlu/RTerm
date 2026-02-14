import { parseCliOptions, printCliHelp, resolveGatewayConnection } from './connection'
import type {
  ChatMessage,
  GatewayProfileSummary,
  GatewaySessionSnapshot,
  GatewaySessionSummary,
  GatewayTerminalSummary,
  UIUpdateAction,
} from './protocol'
import { compactMessageSummary } from './state'
import type { GatewayClient } from './gateway-client'

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2))

  if (options.help) {
    printCliHelp()
    return
  }
  if ((options.mode === 'run' || options.mode === 'hook') && !options.message?.trim()) {
    throw new Error(`Mode "${options.mode}" requires a message.`)
  }

  const { client, url } = await resolveGatewayConnection(options)

  try {
    const terminalsPayload = await client.request<{ terminals: GatewayTerminalSummary[] }>('terminal:list', {})
    const terminals = terminalsPayload.terminals ?? []
    if (terminals.length === 0) {
      throw new Error('No terminal is available on backend. Start gybackend with terminal bootstrap enabled.')
    }

    const initialTerminalId = terminals[0].id

    if (options.mode === 'run') {
      const target = await resolveTaskTarget(client, terminals, initialTerminalId, options.sessionId)
      await runHeadlessMode(client, target.sessionId, target.terminalId, options.message || '')
      return
    }

    if (options.mode === 'hook') {
      const target = await resolveTaskTarget(client, terminals, initialTerminalId, options.sessionId)
      await runHookMode(client, target.sessionId, target.terminalId, options.message || '')
      return
    }

    const profilesData = await safeRequestProfiles(client)
    const sessionSummaries = await safeRequestSessionSummaries(client)
    const initialSession = options.message
      ? await createInitialPromptSession(client, initialTerminalId)
      : await resolveInitialSession(client, terminals, sessionSummaries, initialTerminalId, options.sessionId)

    const { runTui } = await import('./tui-app')
    const tuiPromise = runTui(client, {
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

    if (options.message) {
      void startSessionTask(client, initialSession.id, initialSession.terminalId, options.message).catch((error) => {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(`Failed to send startup message: ${detail}\n`)
      })
    }

    await tuiPromise
  } finally {
    restoreTerminalInputMode()
    client.close()
  }
}

function restoreTerminalInputMode(): void {
  if (!process.stdin.isTTY) return
  if (!process.stdin.isRaw) return
  if (typeof process.stdin.setRawMode !== 'function') return
  process.stdin.setRawMode(false)
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
  preferredSessionId?: string,
): Promise<{ id: string; terminalId: string; title: string; messages: ChatMessage[] }> {
  if (preferredSessionId) {
    const matched = await tryLoadSessionSnapshot(client, terminals, fallbackTerminalId, preferredSessionId)
    if (matched) return matched
  }

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
  const firstSession = await tryLoadSessionSnapshot(client, terminals, fallbackTerminalId, preferred.id, preferred.title)
  if (firstSession) return firstSession

  const created = await createNewSession(client, fallbackTerminalId)
  return {
    id: created.sessionId,
    terminalId: fallbackTerminalId,
    title: 'New Chat',
    messages: [],
  }
}

async function tryLoadSessionSnapshot(
  client: { request: <T>(method: string, params?: Record<string, unknown>) => Promise<T> },
  terminals: GatewayTerminalSummary[],
  fallbackTerminalId: string,
  sessionId: string,
  fallbackTitle?: string,
): Promise<{ id: string; terminalId: string; title: string; messages: ChatMessage[] } | null> {
  try {
    const payload = await client.request<{ session: GatewaySessionSnapshot }>('session:get', {
      sessionId,
    })
    const restored = payload.session
    const terminalId = resolveTerminalId(restored.boundTerminalId, terminals, fallbackTerminalId)
    return {
      id: restored.id,
      terminalId,
      title: restored.title || fallbackTitle || 'Recovered Session',
      messages: restored.messages ?? [],
    }
  } catch {
    return null
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

async function createInitialPromptSession(
  client: { request: <T>(method: string, params?: Record<string, unknown>) => Promise<T> },
  terminalId: string,
): Promise<{ id: string; terminalId: string; title: string; messages: ChatMessage[] }> {
  const created = await createNewSession(client, terminalId)
  return {
    id: created.sessionId,
    terminalId,
    title: 'New Chat',
    messages: [],
  }
}

async function resolveTaskTarget(
  client: { request: <T>(method: string, params?: Record<string, unknown>) => Promise<T> },
  terminals: GatewayTerminalSummary[],
  fallbackTerminalId: string,
  preferredSessionId?: string,
): Promise<{ sessionId: string; terminalId: string }> {
  if (preferredSessionId) {
    const matched = await tryLoadSessionSnapshot(client, terminals, fallbackTerminalId, preferredSessionId)
    if (!matched) {
      throw new Error(`Session not found: ${preferredSessionId}`)
    }
    return {
      sessionId: matched.id,
      terminalId: matched.terminalId,
    }
  }

  const created = await createNewSession(client, fallbackTerminalId)
  return {
    sessionId: created.sessionId,
    terminalId: fallbackTerminalId,
  }
}

async function startSessionTask(
  client: { request: <T>(method: string, params?: Record<string, unknown>) => Promise<T> },
  sessionId: string,
  terminalId: string,
  userText: string,
): Promise<void> {
  await client.request('agent:startTask', {
    sessionId,
    terminalId,
    userText,
    options: {
      startMode: 'normal',
    },
  })
}

async function runHookMode(client: GatewayClient, sessionId: string, terminalId: string, userText: string): Promise<void> {
  await client.request('agent:startTaskAsync', {
    sessionId,
    terminalId,
    userText,
    options: {
      startMode: 'normal',
    },
  })
}

async function runHeadlessMode(client: GatewayClient, sessionId: string, terminalId: string, userText: string): Promise<void> {
  const outputCache = new Map<string, string>()
  const messageTypes = new Map<string, ChatMessage['type']>()

  const unsubscribeUi = client.on('uiUpdate', (update) => {
    if (update.sessionId !== sessionId) return
    handleHeadlessUiUpdate(client, update, outputCache, messageTypes)
  })
  const unsubscribeClose = client.on('close', (code, reason) => {
    process.stderr.write(`\nGateway disconnected (${code}) ${reason}\n`)
  })
  const unsubscribeError = client.on('error', (error) => {
    process.stderr.write(`\nGateway error: ${error.message}\n`)
  })

  try {
    await startSessionTask(client, sessionId, terminalId, userText)
  } finally {
    unsubscribeUi()
    unsubscribeClose()
    unsubscribeError()
  }
}

function handleHeadlessUiUpdate(
  client: GatewayClient,
  update: UIUpdateAction,
  outputCache: Map<string, string>,
  messageTypes: Map<string, ChatMessage['type']>,
): void {
  if (update.type === 'ADD_MESSAGE') {
    const message = update.message
    messageTypes.set(message.id, message.type)
    outputCache.set(message.id, message.metadata?.output || '')

    if (message.type === 'ask') {
      void autoDenyAsk(client, message)
      return
    }

    if (message.role !== 'assistant') return

    if (message.type === 'text') {
      if (message.content) process.stdout.write(message.content)
      return
    }

    const summary = compactMessageSummary(message, true)
    if (summary) {
      process.stdout.write(`\n${summary}\n`)
    }
    return
  }

  if (update.type === 'APPEND_CONTENT') {
    if (update.content) process.stdout.write(update.content)
    return
  }

  if (update.type === 'APPEND_OUTPUT') {
    if (update.outputDelta) process.stdout.write(update.outputDelta)
    return
  }

  if (update.type === 'UPDATE_MESSAGE') {
    const nextOutput = update.patch.metadata?.output
    if (typeof nextOutput !== 'string') return

    const previous = outputCache.get(update.messageId) || ''
    outputCache.set(update.messageId, nextOutput)

    const type = messageTypes.get(update.messageId)
    if (type !== 'command' && type !== 'sub_tool' && type !== 'reasoning') return
    if (!nextOutput) return

    const delta = nextOutput.startsWith(previous) ? nextOutput.slice(previous.length) : nextOutput
    if (delta) process.stdout.write(delta)
  }
}

async function autoDenyAsk(client: GatewayClient, message: ChatMessage): Promise<void> {
  process.stderr.write('\nPermission ask received in run mode, auto-denied.\n')
  try {
    if (message.metadata?.approvalId) {
      await client.request('agent:replyCommandApproval', {
        approvalId: message.metadata.approvalId,
        decision: 'deny',
      })
      return
    }
    const messageId = message.backendMessageId || message.id
    await client.request('agent:replyMessage', {
      messageId,
      payload: { decision: 'deny' },
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Auto-deny failed: ${detail}\n`)
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`GyShell TUI failed: ${message}\n`)
  process.exitCode = 1
})
