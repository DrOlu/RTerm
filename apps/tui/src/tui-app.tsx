import { RGBA, TextAttributes, type KeyBinding, type ScrollBoxRenderable, type TextareaRenderable } from '@opentui/core'
import { render, useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/solid'
import { createEffect, createMemo, For, onCleanup, Show } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import type { GatewayClient } from './gateway-client'
import type {
  ChatMessage,
  GatewayProfileSummary,
  GatewaySessionSnapshot,
  GatewaySessionSummary,
  GatewayTerminalSummary,
  SkillSummary,
} from './protocol'
import { applyUiUpdate, compactMessageSummary, createSessionState, findLatestPendingAsk, type SessionState } from './state'

type OverlayType = 'welcome' | 'command' | 'profile' | 'session' | 'terminal' | 'help'

type OverlayOption = {
  key: string
  title: string
  subtitle?: string
  run: () => void | Promise<void>
}

type SlashOption = {
  command: string
  description: string
}

interface TuiBootstrapData {
  endpoint: string
  terminals: GatewayTerminalSummary[]
  profiles: GatewayProfileSummary[]
  activeProfileId: string
  initialSessionId: string
  initialTerminalId: string
  initialSessionTitle: string
  initialMessages: ChatMessage[]
  restoredSessionCount: number
  recoveredSessions: GatewaySessionSummary[]
}

type SessionMeta = {
  id: string
  title: string
  updatedAt: number
  messagesCount: number
  boundTerminalId?: string
  lastMessagePreview?: string
  loaded: boolean
}

type MentionOption = {
  key: string
  label: string
  token: string
}

type MentionContext = {
  start: number
  end: number
  query: string
}

type SlashContext = {
  query: string
}

const SLASH_COMMANDS: SlashOption[] = [
  { command: 'new', description: 'Create a new session' },
  { command: 'sessions', description: 'Open session list' },
  { command: 'profile', description: 'Select model profile' },
  { command: 'terminal', description: 'Select terminal target' },
  { command: 'stop', description: 'Stop current run' },
  { command: 'help', description: 'Open help panel' },
]

const submitKeybindings: KeyBinding[] = [
  { name: 'return', action: 'submit' },
  { name: 'return', shift: true, action: 'newline' },
]

const ui = {
  bg: RGBA.fromHex('#0b1017'),
  panel: RGBA.fromHex('#111a25'),
  panel2: RGBA.fromHex('#162232'),
  panel3: RGBA.fromHex('#1c2d43'),
  border: RGBA.fromHex('#27405d'),
  text: RGBA.fromHex('#d8e4f0'),
  muted: RGBA.fromHex('#8aa1ba'),
  primary: RGBA.fromHex('#59c0ff'),
  success: RGBA.fromHex('#56cd93'),
  warning: RGBA.fromHex('#f2be69'),
  danger: RGBA.fromHex('#ef7f7f'),
  userBubble: RGBA.fromHex('#162a40'),
  assistantBubble: RGBA.fromHex('#121c2a'),
  systemBubble: RGBA.fromHex('#232015'),
}

export function runTui(client: GatewayClient, data: TuiBootstrapData): Promise<void> {
  return new Promise<void>((resolve) => {
    render(
      () => <TuiApp client={client} data={data} onExit={resolve} />,
      {
        targetFps: 60,
        gatherStats: false,
        exitOnCtrlC: false,
        useKittyKeyboard: {},
      },
    )
  })
}

function TuiApp(props: { client: GatewayClient; data: TuiBootstrapData; onExit: () => void }) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const initialSession = hydrateInitialSession(props.data)
  const boot = buildBootState(props.data, initialSession)

  const [state, setState] = createStore<{
    endpoint: string
    terminals: GatewayTerminalSummary[]
    profiles: GatewayProfileSummary[]
    activeProfileId: string
    activeTerminalId: string
    sessionOrder: string[]
    sessions: Record<string, SessionState>
    sessionMeta: Record<string, SessionMeta>
    activeSessionId: string
    skills: SkillSummary[]
    input: string
    suggestionIndex: number
    overlay: { type: OverlayType; index: number } | null
    pending: boolean
    statusLine: string
  }>({
    endpoint: props.data.endpoint,
    terminals: props.data.terminals,
    profiles: props.data.profiles,
    activeProfileId: props.data.activeProfileId,
    activeTerminalId: props.data.initialTerminalId,
    sessionOrder: boot.sessionOrder,
    sessions: boot.sessions,
    sessionMeta: boot.sessionMeta,
    activeSessionId: props.data.initialSessionId,
    skills: [],
    input: '',
    suggestionIndex: 0,
    overlay:
      props.data.restoredSessionCount > 0
        ? {
            type: 'welcome',
            index: 0,
          }
        : null,
    pending: false,
    statusLine: `Connected: ${props.data.endpoint}`,
  })

  let inputRef: TextareaRenderable | undefined
  let scrollRef: ScrollBoxRenderable | undefined

  const activeSession = createMemo(() => state.sessions[state.activeSessionId])

  const visibleMessages = createMemo(() => {
    const session = activeSession()
    if (!session) return [] as ChatMessage[]
    return session.messages.filter((item) => item.type !== 'tokens_count')
  })

  const pendingAsk = createMemo(() => {
    const session = activeSession()
    if (!session) return undefined
    return findLatestPendingAsk(session)
  })

  const mentionContext = createMemo(() => {
    if (!inputRef) return null
    return parseMentionContext(state.input, inputRef.cursorOffset)
  })

  const mentionOptions = createMemo(() => {
    const context = mentionContext()
    if (!context) return [] as MentionOption[]

    const query = context.query.toLowerCase()
    const terminalOptions = state.terminals
      .filter((item) => matchQuery(query, `${item.title} ${item.id}`))
      .map((item) => ({
        key: `terminal:${item.id}`,
        label: `terminal: ${item.title}`,
        token: `[MENTION_TAB:#${item.title}##${item.id}#]`,
      }))

    const skillOptions = state.skills
      .filter((item) => matchQuery(query, item.name))
      .map((item) => ({
        key: `skill:${item.name}`,
        label: `skill: ${item.name}`,
        token: `[MENTION_SKILL:#${item.name}#]`,
      }))

    return [...skillOptions, ...terminalOptions].slice(0, 8)
  })

  const slashContext = createMemo(() => {
    if (!inputRef) return null
    return parseSlashContext(state.input, inputRef.cursorOffset)
  })

  const slashOptions = createMemo(() => {
    const context = slashContext()
    if (!context) return [] as SlashOption[]

    const starts = SLASH_COMMANDS.filter((item) => item.command.startsWith(context.query))
    const includes = SLASH_COMMANDS.filter(
      (item) => !item.command.startsWith(context.query) && item.command.includes(context.query),
    )
    return [...starts, ...includes].slice(0, 8)
  })

  const suggestionKind = createMemo<'mention' | 'slash' | null>(() => {
    if (mentionOptions().length > 0) return 'mention'
    if (slashOptions().length > 0) return 'slash'
    return null
  })

  createEffect(() => {
    const kind = suggestionKind()
    if (!kind) {
      setState('suggestionIndex', 0)
      return
    }

    const size = kind === 'mention' ? mentionOptions().length : slashOptions().length
    if (size === 0) {
      setState('suggestionIndex', 0)
      return
    }

    if (state.suggestionIndex >= size) {
      setState('suggestionIndex', 0)
    }
  })

  const commandOptions = createMemo<OverlayOption[]>(() => {
    const session = activeSession()
    return [
      {
        key: 'new',
        title: 'New session',
        subtitle: 'Create and switch',
        run: () => {
          void createNewSession(state.activeTerminalId)
        },
      },
      {
        key: 'sessions',
        title: 'Switch session',
        subtitle: 'Browse recovered sessions',
        run: () => openOverlay('session'),
      },
      {
        key: 'profile',
        title: 'Switch profile',
        subtitle: 'Change active model profile',
        run: () => openOverlay('profile'),
      },
      {
        key: 'terminal',
        title: 'Switch terminal',
        subtitle: 'Set target terminal for new sessions',
        run: () => openOverlay('terminal'),
      },
      {
        key: 'stop',
        title: 'Stop run',
        subtitle: 'Send stop to backend',
        run: () => {
          if (!session) return
          void stopSession(session.id)
        },
      },
      {
        key: 'help',
        title: 'Help',
        subtitle: 'Show shortcuts and commands',
        run: () => openOverlay('help'),
      },
      {
        key: 'exit',
        title: 'Exit',
        subtitle: 'Close TUI client',
        run: () => exitApp(),
      },
    ]
  })

  const overlayOptions = createMemo<OverlayOption[]>(() => {
    const overlay = state.overlay
    if (!overlay) return []

    if (overlay.type === 'welcome') {
      return [
        {
          key: 'resume',
          title: 'Resume current session',
          subtitle: `${state.sessionMeta[state.activeSessionId]?.title ?? 'Current session'}`,
          run: () => closeOverlay(),
        },
        {
          key: 'new',
          title: 'Start new session',
          subtitle: `Target: ${lookupTerminalTitle(state.activeTerminalId, state.terminals)}`,
          run: () => {
            void createNewSession(state.activeTerminalId)
          },
        },
        {
          key: 'browse',
          title: 'Browse recovered sessions',
          subtitle: `${state.sessionOrder.length} available`,
          run: () => openOverlay('session'),
        },
      ]
    }

    if (overlay.type === 'command') return commandOptions()

    if (overlay.type === 'profile') {
      return state.profiles.map((profile) => ({
        key: profile.id,
        title: profile.name,
        subtitle: profile.modelName ?? profile.globalModelId,
        run: () => {
          void switchProfile(profile.id)
        },
      }))
    }

    if (overlay.type === 'terminal') {
      return state.terminals.map((terminal) => ({
        key: terminal.id,
        title: terminal.title,
        subtitle: `${terminal.type} (${shortId(terminal.id)})`,
        run: () => {
          setState('activeTerminalId', terminal.id)
          setState('statusLine', `Target terminal: ${terminal.title}`)
          closeOverlay()
        },
      }))
    }

    if (overlay.type === 'session') {
      return state.sessionOrder.map((sessionId) => {
        const meta = state.sessionMeta[sessionId]
        return {
          key: sessionId,
          title: meta?.title || sessionId,
          subtitle: composeSessionSubtitle(meta),
          run: () => {
            void switchSession(sessionId)
          },
        }
      })
    }

    return [
      {
        key: 'close',
        title: 'Back to chat',
        run: () => closeOverlay(),
      },
    ]
  })

  const unsubscribeUi = props.client.on('uiUpdate', (update) => {
    setState(
      produce((draft) => {
        const current = draft.sessions[update.sessionId]
        if (!current) {
          const terminalId = draft.activeTerminalId
          draft.sessions[update.sessionId] = createSessionState(update.sessionId, terminalId, 'New Chat')
          draft.sessionOrder.unshift(update.sessionId)
          draft.sessionMeta[update.sessionId] = {
            id: update.sessionId,
            title: 'New Chat',
            updatedAt: Date.now(),
            messagesCount: 0,
            loaded: true,
          }
        }

        const session = draft.sessions[update.sessionId]
        if (!session) return
        applyUiUpdate(session, update)

        const meta = draft.sessionMeta[update.sessionId]
        if (meta) {
          meta.title = session.title
          meta.updatedAt = Date.now()
          meta.messagesCount = session.messages.length
          meta.lastMessagePreview = previewFromSession(session)
          meta.loaded = true
        }
      }),
    )
  })

  const unsubscribeRaw = props.client.on('raw', (channel, payload) => {
    if (channel === 'skills:updated' && Array.isArray(payload)) {
      const next: SkillSummary[] = payload.flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const name = 'name' in item && typeof item.name === 'string' ? item.name : null
        if (!name) return []
        const description = 'description' in item && typeof item.description === 'string' ? item.description : undefined
        return [{ name, description }]
      })
      setState('skills', next)
      setState('statusLine', `Skills updated (${next.length})`)
      return
    }

    if (channel === 'tools:mcpUpdated') {
      setState('statusLine', 'MCP status updated')
    }
  })

  const unsubscribeEvent = props.client.on('gatewayEvent', (event) => {
    if (event.type === 'system:notification') {
      setState('statusLine', `System: ${safeText(event.payload)}`)
    }
  })

  const unsubscribeClose = props.client.on('close', (code, reason) => {
    setState('statusLine', `Disconnected (${code}) ${reason}`)
  })

  const unsubscribeError = props.client.on('error', (error) => {
    setState('statusLine', `Gateway error: ${error.message}`)
  })

  onCleanup(() => {
    unsubscribeUi()
    unsubscribeRaw()
    unsubscribeEvent()
    unsubscribeClose()
    unsubscribeError()
  })

  createEffect(() => {
    const count = visibleMessages().length
    void count
    queueMicrotask(() => {
      if (!scrollRef) return
      try {
        scrollRef.scrollTo(scrollRef.scrollHeight)
      } catch {
        // keep rendering even if scroll is unavailable
      }
    })
  })

  useKeyboard((event) => {
    if (event.ctrl && event.name === 'c') {
      event.preventDefault()
      exitApp()
      return
    }

    if (event.ctrl && event.name === 'k') {
      event.preventDefault()
      openOverlay('command')
      return
    }

    if (event.ctrl && event.name === 'n') {
      event.preventDefault()
      void createNewSession(state.activeTerminalId)
      return
    }

    if (event.ctrl && event.name === 'l') {
      event.preventDefault()
      openOverlay('session')
      return
    }

    const ask = pendingAsk()
    if (!state.overlay && ask) {
      if (event.name === 'a') {
        event.preventDefault()
        void resolveAsk(ask, 'allow')
        return
      }
      if (event.name === 'd') {
        event.preventDefault()
        void resolveAsk(ask, 'deny')
        return
      }
    }

    if (!state.overlay) return

    if (event.name === 'escape') {
      event.preventDefault()
      closeOverlay()
      return
    }

    if (event.name === 'up' || event.name === 'k') {
      event.preventDefault()
      moveOverlayIndex(-1)
      return
    }

    if (event.name === 'down' || event.name === 'j') {
      event.preventDefault()
      moveOverlayIndex(1)
      return
    }

    if (event.name === 'return') {
      event.preventDefault()
      void selectOverlayOption()
    }
  })

  function openOverlay(type: OverlayType): void {
    setState('overlay', {
      type,
      index: 0,
    })
  }

  function closeOverlay(): void {
    setState('overlay', null)
  }

  function moveOverlayIndex(direction: number): void {
    const options = overlayOptions()
    if (!options.length) return

    setState(
      produce((draft) => {
        if (!draft.overlay) return
        let next = draft.overlay.index + direction
        if (next < 0) next = options.length - 1
        if (next >= options.length) next = 0
        draft.overlay.index = next
      }),
    )
  }

  async function selectOverlayOption(): Promise<void> {
    const overlay = state.overlay
    if (!overlay) return
    const options = overlayOptions()
    const selected = options[overlay.index]
    if (!selected) return
    await selected.run()
  }

  function handleInputContentChange(): void {
    if (!inputRef) return
    setState('input', inputRef.plainText)
    setState('suggestionIndex', 0)
  }

  function handleInputKeyDown(event: { name: string; preventDefault: () => void }): void {
    if (state.overlay) return

    const kind = suggestionKind()
    if (!kind) return

    const options = kind === 'mention' ? mentionOptions() : slashOptions()
    if (!options.length) return

    if (event.name === 'down') {
      event.preventDefault()
      setState('suggestionIndex', (value) => (value + 1) % options.length)
      return
    }

    if (event.name === 'up') {
      event.preventDefault()
      setState('suggestionIndex', (value) => (value - 1 + options.length) % options.length)
      return
    }

    if (event.name === 'escape') {
      event.preventDefault()
      if (kind === 'mention') {
        const context = mentionContext()
        if (!context) return
        const next = `${state.input.slice(0, context.start)}${state.input.slice(context.end)}`
        setState('input', next)
        if (inputRef) {
          inputRef.setText(next)
          inputRef.cursorOffset = context.start
        }
      }
      return
    }

    if (event.name === 'tab') {
      event.preventDefault()
      if (kind === 'mention') {
        insertMention(mentionOptions()[state.suggestionIndex])
      } else {
        insertSlash(slashOptions()[state.suggestionIndex])
      }
    }
  }

  function insertMention(option: MentionOption | undefined): void {
    if (!option || !inputRef) return
    const context = mentionContext()
    if (!context) return

    const next = `${state.input.slice(0, context.start)}${option.token} ${state.input.slice(context.end)}`
    setState('input', next)
    setState('suggestionIndex', 0)
    inputRef.setText(next)
    inputRef.cursorOffset = context.start + option.token.length + 1
  }

  function insertSlash(option: SlashOption | undefined): void {
    if (!option || !inputRef) return
    const next = `/${option.command} `
    setState('input', next)
    setState('suggestionIndex', 0)
    inputRef.setText(next)
    inputRef.gotoBufferEnd()
  }

  async function submitInput(): Promise<void> {
    if (state.overlay) return

    const text = state.input.trim()
    if (!text) return

    if (text.startsWith('/')) {
      await runSlashCommand(text)
      clearInput()
      return
    }

    const session = activeSession()
    if (!session) {
      setState('statusLine', 'No active session available')
      return
    }

    setState('pending', true)

    try {
      await props.client.request('agent:startTask', {
        sessionId: session.id,
        terminalId: session.terminalId,
        userText: text,
        options: {
          startMode: session.isBusy ? 'inserted' : 'normal',
        },
      })

      setState(
        produce((draft) => {
          const current = draft.sessions[session.id]
          if (!current) return
          current.isThinking = true
          current.isBusy = true
          current.lockedProfileId = draft.activeProfileId || null
        }),
      )
    } catch (error) {
      setState('statusLine', `Failed to send prompt: ${safeError(error)}`)
    } finally {
      setState('pending', false)
      clearInput()
    }
  }

  async function runSlashCommand(raw: string): Promise<void> {
    const [command] = raw.slice(1).split(/\s+/)

    if (command === 'new') {
      await createNewSession(state.activeTerminalId)
      return
    }

    if (command === 'session' || command === 'sessions') {
      openOverlay('session')
      return
    }

    if (command === 'profile') {
      openOverlay('profile')
      return
    }

    if (command === 'terminal') {
      openOverlay('terminal')
      return
    }

    if (command === 'help') {
      openOverlay('help')
      return
    }

    if (command === 'stop') {
      const session = activeSession()
      if (session) await stopSession(session.id)
      return
    }

    setState('statusLine', `Unknown slash command: /${command}`)
  }

  function clearInput(): void {
    setState('input', '')
    setState('suggestionIndex', 0)
    if (inputRef) inputRef.clear()
  }

  async function createNewSession(terminalId: string): Promise<void> {
    setState('pending', true)
    try {
      const result = await props.client.request<{ sessionId: string }>('gateway:createSession', { terminalId })
      const sessionId = result.sessionId

      setState(
        produce((draft) => {
          if (!draft.sessions[sessionId]) {
            draft.sessions[sessionId] = createSessionState(sessionId, terminalId)
            draft.sessionOrder.unshift(sessionId)
          }
          draft.sessionMeta[sessionId] = {
            id: sessionId,
            title: draft.sessions[sessionId]?.title || 'New Chat',
            updatedAt: Date.now(),
            messagesCount: 0,
            boundTerminalId: terminalId,
            loaded: true,
          }
          draft.activeSessionId = sessionId
        }),
      )

      setState('statusLine', `Created session: ${shortId(sessionId)}`)
      closeOverlay()
    } catch (error) {
      setState('statusLine', `Failed to create session: ${safeError(error)}`)
    } finally {
      setState('pending', false)
    }
  }

  async function switchSession(sessionId: string): Promise<void> {
    await ensureSessionLoaded(sessionId)
    setState('activeSessionId', sessionId)
    setState('statusLine', `Switched session: ${state.sessionMeta[sessionId]?.title || shortId(sessionId)}`)
    closeOverlay()
  }

  async function ensureSessionLoaded(sessionId: string): Promise<void> {
    const meta = state.sessionMeta[sessionId]
    if (meta?.loaded) return

    try {
      const payload = await props.client.request<{ session: GatewaySessionSnapshot }>('session:get', { sessionId })
      const snapshot = payload.session
      setState(
        produce((draft) => {
          const terminalId = resolveTerminalId(snapshot.boundTerminalId, draft.terminals, draft.activeTerminalId)
          const session = createSessionState(sessionId, terminalId, snapshot.title || 'Recovered Session')
          session.messages = (snapshot.messages || []).map(cloneMessage)
          session.isBusy = false
          session.isThinking = false
          draft.sessions[sessionId] = session

          const current = draft.sessionMeta[sessionId]
          draft.sessionMeta[sessionId] = {
            id: sessionId,
            title: snapshot.title || current?.title || 'Recovered Session',
            updatedAt: snapshot.updatedAt || current?.updatedAt || Date.now(),
            messagesCount: snapshot.messages?.length ?? current?.messagesCount ?? 0,
            boundTerminalId: snapshot.boundTerminalId || current?.boundTerminalId,
            lastMessagePreview: current?.lastMessagePreview,
            loaded: true,
          }
        }),
      )
    } catch (error) {
      setState('statusLine', `Failed to load session ${shortId(sessionId)}: ${safeError(error)}`)
    }
  }

  async function switchProfile(profileId: string): Promise<void> {
    try {
      const result = await props.client.request<{ activeProfileId: string; profiles: GatewayProfileSummary[] }>(
        'models:setActiveProfile',
        { profileId },
      )

      setState('activeProfileId', result.activeProfileId)
      setState('profiles', result.profiles)
      setState('statusLine', `Profile: ${lookupProfileName(result.activeProfileId, result.profiles)}`)
      closeOverlay()
    } catch (error) {
      setState('statusLine', `Profile switch failed: ${safeError(error)}`)
    }
  }

  async function stopSession(sessionId: string): Promise<void> {
    try {
      await props.client.request('agent:stopTask', { sessionId })
      setState('statusLine', 'Stop signal sent')
    } catch (error) {
      setState('statusLine', `Stop failed: ${safeError(error)}`)
    }
  }

  async function resolveAsk(message: ChatMessage, decision: 'allow' | 'deny'): Promise<void> {
    try {
      if (message.metadata?.approvalId) {
        await props.client.request('agent:replyCommandApproval', {
          approvalId: message.metadata.approvalId,
          decision,
        })
      } else {
        await props.client.request('agent:replyMessage', {
          messageId: message.backendMessageId ?? message.id,
          payload: { decision },
        })
      }

      setState(
        produce((draft) => {
          const session = draft.sessions[draft.activeSessionId]
          if (!session) return
          const target = session.messages.find((item) => item.id === message.id)
          if (!target) return
          target.metadata = {
            ...(target.metadata ?? {}),
            decision,
          }
        }),
      )
      setState('statusLine', `Decision sent: ${decision}`)
    } catch (error) {
      setState('statusLine', `Approval failed: ${safeError(error)}`)
    }
  }

  function exitApp(): void {
    props.client.close()
    renderer.destroy()
    props.onExit()
  }

  const selectedProfileName = createMemo(() => lookupProfileName(state.activeProfileId, state.profiles))
  const activeSessionShortId = createMemo(() => shortId(state.activeSessionId))
  const activeSessionMeta = createMemo(() => state.sessionMeta[state.activeSessionId])

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={ui.bg} flexDirection="column">
      <box flexShrink={0} backgroundColor={ui.panel} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        <text fg={ui.primary} attributes={TextAttributes.BOLD}>
          GyShell TUI
        </text>
        <text fg={ui.muted}> | </text>
        <text fg={ui.text}>{selectedProfileName()}</text>
        <text fg={ui.muted}> | {lookupTerminalTitle(state.activeTerminalId, state.terminals)}</text>
        <box flexGrow={1} />
        <text fg={state.pending ? ui.warning : ui.success}>{state.pending ? 'RUNNING' : 'IDLE'}</text>
      </box>

      <box flexShrink={0} backgroundColor={ui.panel2} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        <text fg={ui.text} attributes={TextAttributes.BOLD}>
          {truncateLine(activeSessionMeta()?.title || 'Untitled Session', 64)}
        </text>
        <text fg={ui.muted}> ({activeSessionShortId()})</text>
        <text fg={ui.muted}> • {visibleMessages().length} msgs</text>
        <Show when={props.data.restoredSessionCount > 0}>
          <text fg={ui.muted}> • recovered {props.data.restoredSessionCount}</text>
        </Show>
        <box flexGrow={1} />
        <text fg={ui.muted}>Ctrl+K commands</text>
      </box>

      <scrollbox
        ref={(node: ScrollBoxRenderable) => (scrollRef = node)}
        flexGrow={1}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
      >
        <Show when={visibleMessages().length === 0}>
          <box paddingTop={1}>
            <text fg={ui.muted}>No messages yet. Type prompt and press Enter.</text>
          </box>
        </Show>

        <For each={visibleMessages()}>
          {(message, index) => (
            <box marginTop={showHeader(visibleMessages(), index()) ? 1 : 0}>
              <Show when={showHeader(visibleMessages(), index())}>
                <text fg={labelColorForMessage(message)} attributes={TextAttributes.BOLD}>
                  {labelForMessage(message)}
                  <span style={{ fg: ui.muted }}> {formatClock(message.timestamp)}</span>
                </text>
              </Show>

              <box
                paddingLeft={1}
                border={['left']}
                borderColor={borderColorForMessage(message)}
                backgroundColor={bubbleColorForMessage(message)}
              >
                <text fg={ui.text}>{compactMessageSummary(message, false)}</text>
              </box>
            </box>
          )}
        </For>
      </scrollbox>

      <Show when={pendingAsk()}>
        {(ask) => (
          <box flexShrink={0} backgroundColor={ui.panel3} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            <text fg={ui.warning}>
              Permission: {truncateLine(ask().metadata?.command || ask().content, 100)}
              <span style={{ fg: ui.muted }}> (A allow / D deny)</span>
            </text>
          </box>
        )}
      </Show>

      <Show when={suggestionKind() && !state.overlay}>
        <box flexShrink={0} backgroundColor={ui.panel3} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <For each={suggestionKind() === 'mention' ? mentionOptions() : slashOptions()}>
            {(option, idx) => (
              <text fg={idx() === state.suggestionIndex ? ui.primary : ui.muted}>
                {idx() === state.suggestionIndex ? '> ' : '  '}
                {suggestionKind() === 'mention' ? (option as MentionOption).label : `/${(option as SlashOption).command}`}
                <Show when={suggestionKind() === 'slash'}>
                  <span style={{ fg: ui.muted }}> {(option as SlashOption).description}</span>
                </Show>
              </text>
            )}
          </For>
        </box>
      </Show>

      <box flexShrink={0} backgroundColor={ui.panel} paddingLeft={2} paddingRight={2} paddingTop={1}>
        <textarea
          ref={(node: TextareaRenderable) => {
            inputRef = node
            node.focus()
          }}
          placeholder="Type a prompt. Enter send, Shift+Enter newline, / for commands, @ for mentions"
          minHeight={1}
          maxHeight={6}
          textColor={ui.text}
          focusedTextColor={ui.text}
          cursorColor={ui.primary}
          keyBindings={submitKeybindings}
          onContentChange={handleInputContentChange}
          onKeyDown={(event) => handleInputKeyDown(event as any)}
          onSubmit={() => {
            void submitInput()
          }}
        />
      </box>

      <box flexShrink={0} backgroundColor={ui.panel2} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={ui.muted}>{state.statusLine}</text>
        <box flexGrow={1} />
        <text fg={state.pending ? ui.warning : ui.muted}>{state.pending ? 'Working...' : activeSessionShortId()}</text>
      </box>

      <Show when={state.overlay}>
        {(overlay) => (
          <box position="absolute" top={3} left={2} right={2} bottom={2} alignItems="center" backgroundColor={ui.bg}>
            <box
              width={Math.max(48, Math.min(110, dimensions().width - 8))}
              backgroundColor={ui.panel2}
              border={['top', 'bottom', 'left', 'right']}
              borderColor={ui.border}
              padding={1}
            >
              <box flexDirection="row">
                <text fg={ui.text} attributes={TextAttributes.BOLD}>
                  {overlayTitle(overlay().type)}
                </text>
                <box flexGrow={1} />
                <text fg={ui.muted}>Esc close</text>
              </box>

              <Show when={overlay().type === 'help'}>
                <box paddingTop={1}>
                  <text fg={ui.text}>Shortcuts</text>
                  <text fg={ui.muted}>Ctrl+K command palette</text>
                  <text fg={ui.muted}>Ctrl+N new session</text>
                  <text fg={ui.muted}>Ctrl+L session list</text>
                  <text fg={ui.muted}>Ctrl+C exit</text>
                  <text fg={ui.text}>Input</text>
                  <text fg={ui.muted}>Enter send, Shift+Enter newline</text>
                  <text fg={ui.muted}>Tab accepts @ or / suggestion</text>
                  <text fg={ui.muted}>A / D respond to permission asks</text>
                </box>
              </Show>

              <Show when={overlay().type !== 'help'}>
                <box paddingTop={1}>
                  <For each={overlayOptions()}>
                    {(option, idx) => (
                      <box
                        paddingLeft={1}
                        paddingRight={1}
                        backgroundColor={idx() === overlay().index ? ui.primary : undefined}
                      >
                        <text fg={idx() === overlay().index ? ui.bg : ui.text}>
                          {option.title}
                          <Show when={option.subtitle}>
                            <span style={{ fg: idx() === overlay().index ? ui.bg : ui.muted }}> {option.subtitle}</span>
                          </Show>
                        </text>
                      </box>
                    )}
                  </For>
                </box>
              </Show>
            </box>
          </box>
        )}
      </Show>
    </box>
  )
}

function buildBootState(data: TuiBootstrapData, initialSession: SessionState): {
  sessions: Record<string, SessionState>
  sessionMeta: Record<string, SessionMeta>
  sessionOrder: string[]
} {
  const sessions: Record<string, SessionState> = {
    [data.initialSessionId]: initialSession,
  }

  const sessionMeta: Record<string, SessionMeta> = {}
  sessionMeta[data.initialSessionId] = {
    id: data.initialSessionId,
    title: initialSession.title,
    updatedAt: Date.now(),
    messagesCount: initialSession.messages.length,
    boundTerminalId: data.initialTerminalId,
    lastMessagePreview: previewFromSession(initialSession),
    loaded: true,
  }

  for (const summary of data.recoveredSessions) {
    const existing = sessionMeta[summary.id]
    sessionMeta[summary.id] = {
      id: summary.id,
      title: summary.title || existing?.title || 'Recovered Session',
      updatedAt: summary.updatedAt || existing?.updatedAt || Date.now(),
      messagesCount: summary.messagesCount || existing?.messagesCount || 0,
      boundTerminalId: summary.boundTerminalId || existing?.boundTerminalId,
      lastMessagePreview: summary.lastMessagePreview || existing?.lastMessagePreview,
      loaded: summary.id === data.initialSessionId,
    }

    if (summary.id !== data.initialSessionId) {
      const terminalId = summary.boundTerminalId || data.initialTerminalId
      sessions[summary.id] = createSessionState(summary.id, terminalId, summary.title || 'Recovered Session')
    }
  }

  const sessionOrder = Object.values(sessionMeta)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((item) => item.id)

  if (!sessionOrder.includes(data.initialSessionId)) {
    sessionOrder.unshift(data.initialSessionId)
  }

  return {
    sessions,
    sessionMeta,
    sessionOrder,
  }
}

function parseMentionContext(text: string, cursorOffset: number): MentionContext | null {
  if (!text) return null
  const safeOffset = Math.max(0, Math.min(cursorOffset, text.length))
  const head = text.slice(0, safeOffset)
  const start = head.lastIndexOf('@')
  if (start < 0) return null

  const before = start === 0 ? ' ' : text[start - 1]
  if (!/\s/.test(before)) return null

  const between = text.slice(start + 1, safeOffset)
  if (/\s/.test(between)) return null

  return {
    start,
    end: safeOffset,
    query: between,
  }
}

function parseSlashContext(text: string, cursorOffset: number): SlashContext | null {
  if (!text.startsWith('/')) return null
  const safeOffset = Math.max(0, Math.min(cursorOffset, text.length))
  const head = text.slice(0, safeOffset)
  if (head.includes('\n')) return null
  if (head.includes(' ')) return null
  return {
    query: head.slice(1).toLowerCase(),
  }
}

function matchQuery(query: string, candidate: string): boolean {
  if (!query) return true
  return candidate.toLowerCase().includes(query)
}

function showHeader(messages: ChatMessage[], index: number): boolean {
  const current = messages[index]
  const previous = messages[index - 1]
  if (!current || !previous) return true

  const sameRole = current.role === previous.role
  const sameType = labelForMessage(current) === labelForMessage(previous)
  const closeInTime = Math.abs(current.timestamp - previous.timestamp) < 90_000
  return !(sameRole && sameType && closeInTime)
}

function labelForMessage(message: ChatMessage): string {
  if (message.role === 'user') return 'YOU'
  if (message.type === 'error') return 'ERROR'
  if (message.type === 'alert') return 'ALERT'
  if (message.type === 'ask') return 'ASK'
  if (message.type === 'command') return 'CMD'
  if (message.type === 'tool_call') return 'TOOL'
  if (message.type === 'file_edit') return 'EDIT'
  if (message.type === 'reasoning') return 'THINK'
  if (message.type === 'sub_tool') return 'STEP'
  return 'AI'
}

function labelColorForMessage(message: ChatMessage): RGBA {
  if (message.role === 'user') return ui.primary
  if (message.type === 'error') return ui.danger
  if (message.type === 'alert' || message.type === 'ask') return ui.warning
  if (message.type === 'command' || message.type === 'tool_call' || message.type === 'file_edit') return ui.primary
  if (message.type === 'reasoning' || message.type === 'sub_tool') return ui.muted
  return ui.success
}

function borderColorForMessage(message: ChatMessage): RGBA {
  if (message.role === 'user') return ui.primary
  if (message.type === 'error') return ui.danger
  if (message.type === 'alert' || message.type === 'ask') return ui.warning
  return ui.border
}

function bubbleColorForMessage(message: ChatMessage): RGBA | undefined {
  if (message.role === 'user') return ui.userBubble
  if (message.type === 'alert' || message.type === 'ask') return ui.systemBubble
  if (message.type === 'error') return ui.systemBubble
  return ui.assistantBubble
}

function overlayTitle(type: OverlayType): string {
  if (type === 'welcome') return 'Welcome Back'
  if (type === 'command') return 'Command Palette'
  if (type === 'profile') return 'Model Profiles'
  if (type === 'session') return 'Sessions'
  if (type === 'terminal') return 'Terminals'
  return 'Help'
}

function lookupProfileName(activeId: string, profiles: GatewayProfileSummary[]): string {
  const match = profiles.find((item) => item.id === activeId)
  if (!match) return activeId || 'No profile'
  return match.modelName ? `${match.name} (${match.modelName})` : match.name
}

function lookupTerminalTitle(id: string, terminals: GatewayTerminalSummary[]): string {
  const match = terminals.find((item) => item.id === id)
  return match ? match.title : shortId(id)
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

function composeSessionSubtitle(meta: SessionMeta | undefined): string {
  if (!meta) return 'No metadata'
  const flags = [
    `${meta.messagesCount} msgs`,
    formatShortDate(meta.updatedAt),
    meta.loaded ? 'cached' : 'load on open',
  ]
  if (meta.lastMessagePreview) flags.push(truncateLine(meta.lastMessagePreview, 40))
  return flags.join(' • ')
}

function formatShortDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'unknown time'
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hh}:${mm}`
}

function formatClock(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '--:--'
  const date = new Date(timestamp)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function truncateLine(input: string, max: number): string {
  const normalized = String(input || '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 1)}...`
}

function shortId(input: string): string {
  if (!input) return 'unknown'
  if (input.length <= 10) return input
  return `${input.slice(0, 4)}...${input.slice(-4)}`
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function safeText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (payload && typeof payload === 'object') return JSON.stringify(payload)
  return String(payload)
}

function hydrateInitialSession(data: TuiBootstrapData): SessionState {
  const session = createSessionState(data.initialSessionId, data.initialTerminalId, data.initialSessionTitle || 'New Chat')
  session.messages = data.initialMessages.map(cloneMessage)
  session.isThinking = false
  session.isBusy = false
  return session
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    metadata: message.metadata ? { ...message.metadata } : undefined,
  }
}

function previewFromSession(session: SessionState): string {
  const latestVisible = [...session.messages].reverse().find((msg) => msg.type !== 'tokens_count')
  if (!latestVisible) return ''
  return truncateLine(latestVisible.content || latestVisible.metadata?.output || '', 120)
}
