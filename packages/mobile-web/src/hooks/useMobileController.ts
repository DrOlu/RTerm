import React from 'react'
import { GatewayClient } from '../gateway-client'
import { loadGatewayUrlFromStorage, normalizeGatewayUrl, saveGatewayUrlToStorage } from '../lib/gateway-url'
import {
  applyMentionToInput,
  encodeMentions,
  getMentionSuggestions,
  type MentionOption
} from '../lib/mentions'
import { buildChatTimeline, getLatestTokenUsage, type ChatTimelineItem } from '../lib/chat-timeline'
import {
  applyUiUpdate,
  cloneMessage,
  cloneSession,
  createSessionState,
  normalizeDisplayText,
  previewFromSession,
  reorderSessionIds,
  type SessionMeta,
  type SessionState
} from '../session-store'
import type {
  ChatMessage,
  GatewayProfileSummary,
  GatewaySessionSnapshot,
  GatewaySessionSummary,
  SkillSummary,
  GatewayTerminalSummary,
  UIUpdateAction
} from '../types'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

interface ViewState {
  terminals: GatewayTerminalSummary[]
  skills: SkillSummary[]
  profiles: GatewayProfileSummary[]
  activeProfileId: string
  sessions: Record<string, SessionState>
  sessionMeta: Record<string, SessionMeta>
  sessionOrder: string[]
  activeSessionId: string | null
  statusLine: string
}

const INITIAL_VIEW_STATE: ViewState = {
  terminals: [],
  skills: [],
  profiles: [],
  activeProfileId: '',
  sessions: {},
  sessionMeta: {},
  sessionOrder: [],
  activeSessionId: null,
  statusLine: 'Ready'
}

function buildSessionMeta(
  session: SessionState,
  previous: SessionMeta | undefined,
  patch?: Partial<SessionMeta>
): SessionMeta {
  return {
    id: session.id,
    title: session.title,
    updatedAt: Date.now(),
    messagesCount: session.messages.length,
    lastMessagePreview: previewFromSession(session),
    loaded: previous?.loaded ?? true,
    ...patch
  }
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function compactStatusLabel(text: string, limit = 28): string {
  const normalized = normalizeDisplayText(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return 'Untitled'
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, Math.max(1, limit - 3))}...`
}

function normalizeSkillItem(raw: unknown, enabledByName: Set<string> | null): SkillSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  if (typeof data.name !== 'string' || !data.name) return null
  const localEnabled = typeof data.enabled === 'boolean' ? data.enabled : undefined
  const enabled = enabledByName ? enabledByName.has(data.name) : localEnabled !== false

  return {
    name: data.name,
    description: typeof data.description === 'string' ? data.description : undefined,
    enabled,
    fileName: typeof data.fileName === 'string' ? data.fileName : undefined,
    filePath: typeof data.filePath === 'string' ? data.filePath : undefined,
    baseDir: typeof data.baseDir === 'string' ? data.baseDir : undefined,
    scanRoot: typeof data.scanRoot === 'string' ? data.scanRoot : undefined,
    isNested: data.isNested === true,
    supportingFiles: Array.isArray(data.supportingFiles)
      ? data.supportingFiles.filter((item): item is string => typeof item === 'string')
      : undefined
  }
}

function mergeSkillsByName(previous: SkillSummary[], incoming: SkillSummary[]): SkillSummary[] {
  const byName = new Map(previous.map((skill) => [skill.name, skill]))
  for (const skill of incoming) {
    const prev = byName.get(skill.name)
    byName.set(skill.name, {
      ...(prev || {}),
      ...skill
    })
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function collectEnabledSkillNames(payload: unknown[]): Set<string> {
  return new Set(
    payload
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        if (!('name' in item) || typeof item.name !== 'string') return null
        if ('enabled' in item && item.enabled === false) return null
        return item.name
      })
      .filter((name): name is string => !!name)
  )
}

async function fetchSkillsSnapshot(client: GatewayClient): Promise<SkillSummary[]> {
  try {
    const [allRaw, enabledRaw] = await Promise.all([
      client.request<unknown>('skills:getAll', {}),
      client.request<unknown>('skills:getEnabled', {})
    ])

    if (Array.isArray(allRaw) && Array.isArray(enabledRaw)) {
      const enabledByName = new Set(
        enabledRaw
          .map((item) => (item && typeof item === 'object' && 'name' in item ? (item as { name?: unknown }).name : null))
          .filter((name): name is string => typeof name === 'string' && !!name)
      )
      return allRaw
        .map((item) => normalizeSkillItem(item, enabledByName))
        .filter((item): item is SkillSummary => !!item)
        .sort((left, right) => left.name.localeCompare(right.name))
    }
  } catch {
    // fallback to legacy list API
  }

  const payload = await client.request<{ skills: SkillSummary[] }>('skills:list', {})
  return (payload.skills || [])
    .map((item) => normalizeSkillItem(item, null))
    .filter((item): item is SkillSummary => !!item)
    .sort((left, right) => left.name.localeCompare(right.name))
}

export interface MobileControllerState {
  gatewayInput: string
  connectionStatus: ConnectionStatus
  connectionError: string
  actionPending: boolean
  composerValue: string
  composerCursor: number
  mentionOptions: MentionOption[]
  terminals: GatewayTerminalSummary[]
  skills: SkillSummary[]
  profiles: GatewayProfileSummary[]
  activeProfileId: string
  activeSession: SessionState | null
  activeSessionId: string | null
  chatTimeline: ChatTimelineItem[]
  sessionOrder: string[]
  sessionMeta: Record<string, SessionMeta>
  sessions: Record<string, SessionState>
  statusLine: string
  isRunning: boolean
  latestTokens: number
  latestMaxTokens: number
  tokenUsagePercent: number | null
}

export interface MobileControllerActions {
  setGatewayInput: (value: string) => void
  setComposerValue: (value: string, cursor: number) => void
  setComposerCursor: (cursor: number) => void
  pickMention: (option: MentionOption) => void
  connectGateway: () => Promise<void>
  disconnectGateway: () => void
  switchSession: (sessionId: string) => Promise<void>
  createSession: () => Promise<string | null>
  sendMessage: () => Promise<void>
  stopActiveSession: () => Promise<void>
  updateProfile: (profileId: string) => Promise<void>
  reloadSkills: () => Promise<void>
  setSkillEnabled: (name: string, enabled: boolean) => Promise<void>
  replyAsk: (message: ChatMessage, decision: 'allow' | 'deny') => Promise<void>
  createTerminalTab: () => Promise<void>
  closeTerminalTab: (terminalId: string) => Promise<void>
}

export function useMobileController(): {
  state: MobileControllerState
  actions: MobileControllerActions
} {
  const clientRef = React.useRef<GatewayClient>()
  if (!clientRef.current) {
    clientRef.current = new GatewayClient()
  }
  const client = clientRef.current

  const [gatewayInput, setGatewayInput] = React.useState<string>(() => loadGatewayUrlFromStorage())
  const [connectionStatus, setConnectionStatus] = React.useState<ConnectionStatus>('disconnected')
  const [connectionError, setConnectionError] = React.useState('')
  const [actionPending, setActionPending] = React.useState(false)

  const [composerValue, setComposerValueRaw] = React.useState('')
  const [composerCursor, setComposerCursor] = React.useState(0)

  const [view, setView] = React.useState<ViewState>(INITIAL_VIEW_STATE)
  const viewRef = React.useRef<ViewState>(INITIAL_VIEW_STATE)
  React.useEffect(() => {
    viewRef.current = view
  }, [view])

  const activeSession = React.useMemo(() => {
    if (!view.activeSessionId) return null
    return view.sessions[view.activeSessionId] || null
  }, [view.activeSessionId, view.sessions])

  const sessionMessages = activeSession?.messages || []
  const chatTimeline = React.useMemo(() => buildChatTimeline(sessionMessages), [sessionMessages])
  const tokenUsage = React.useMemo(() => getLatestTokenUsage(sessionMessages), [sessionMessages])

  const mentionState = React.useMemo(() => {
    return getMentionSuggestions(composerValue, composerCursor, view.terminals, view.skills)
  }, [composerCursor, composerValue, view.skills, view.terminals])

  const applyLiveUpdate = React.useCallback((update: UIUpdateAction) => {
    setView((previous) => {
      const sessions = { ...previous.sessions }
      const sessionMeta = { ...previous.sessionMeta }
      const sessionOrder = [...previous.sessionOrder]

      const current = sessions[update.sessionId]
      const nextSession = current
        ? cloneSession(current)
        : createSessionState(update.sessionId, 'New Chat')
      const wasBusy = nextSession.isBusy

      if (
        update.type === 'ADD_MESSAGE' ||
        update.type === 'APPEND_CONTENT' ||
        update.type === 'APPEND_OUTPUT' ||
        update.type === 'UPDATE_MESSAGE'
      ) {
        nextSession.isBusy = true
      }

      if (
        update.type === 'ADD_MESSAGE' &&
        update.message.role === 'user' &&
        !wasBusy &&
        !nextSession.lockedProfileId
      ) {
        nextSession.lockedProfileId = previous.activeProfileId || null
      }

      applyUiUpdate(nextSession, update)
      sessions[update.sessionId] = nextSession

      if (!sessionOrder.includes(update.sessionId)) {
        sessionOrder.unshift(update.sessionId)
      }

      const prevMeta = sessionMeta[update.sessionId]
      sessionMeta[update.sessionId] = buildSessionMeta(nextSession, prevMeta, {
        loaded: true,
        updatedAt: Date.now()
      })

      return {
        ...previous,
        sessions,
        sessionMeta,
        sessionOrder: reorderSessionIds(sessionOrder, sessionMeta),
        activeSessionId: previous.activeSessionId || update.sessionId
      }
    })
  }, [])

  React.useEffect(() => {
    const unsubscribers = [
      client.on('status', (status, detail) => {
        setConnectionStatus(status)
        if (status === 'connecting') {
          setConnectionError('')
          setView((previous) => ({ ...previous, statusLine: 'Connecting gateway...' }))
        }
        if (status === 'connected') {
          setConnectionError('')
          setView((previous) => ({ ...previous, statusLine: 'Gateway connected' }))
        }
        if (status === 'disconnected') {
          const reason = detail || 'connection closed'
          setView((previous) => ({ ...previous, statusLine: `Disconnected: ${reason}` }))
        }
      }),
      client.on('error', (message) => {
        setConnectionError(message)
      }),
      client.on('uiUpdate', (update) => {
        applyLiveUpdate(update)
      }),
      client.on('gatewayEvent', (event) => {
        if (event.type !== 'system:notification') return
        const text = typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload)
        setView((previous) => ({ ...previous, statusLine: text }))
      }),
      client.on('raw', (channel, payload) => {
        if (channel === 'terminal:tabs') {
          const terminals =
            payload &&
            typeof payload === 'object' &&
            'terminals' in payload &&
            Array.isArray((payload as { terminals?: unknown[] }).terminals)
              ? ((payload as { terminals: GatewayTerminalSummary[] }).terminals || [])
              : []
          setView((previous) => ({
            ...previous,
            terminals,
            statusLine: `Terminal tabs: ${terminals.length}`
          }))
          return
        }

        if (channel === 'tools:mcpUpdated') {
          setView((previous) => ({ ...previous, statusLine: 'MCP status updated' }))
          return
        }

        if (channel === 'tools:builtInUpdated') {
          setView((previous) => ({ ...previous, statusLine: 'Built-in tools updated' }))
          return
        }

        if (channel === 'skills:updated') {
          if (!Array.isArray(payload)) return
          const enabledNames = collectEnabledSkillNames(payload)
          setView((previous) => {
            const nextSkills =
              previous.skills.length === 0
                ? payload
                    .map((item) => normalizeSkillItem(item, enabledNames))
                    .filter((item): item is SkillSummary => !!item)
                    .sort((left, right) => left.name.localeCompare(right.name))
                : previous.skills.map((skill) => ({
                    ...skill,
                    enabled: enabledNames.has(skill.name)
                  }))
            return {
              ...previous,
              skills: nextSkills,
              statusLine: `Skills updated (${enabledNames.size})`
            }
          })
        }
      })
    ]

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe())
      client.disconnect()
    }
  }, [applyLiveUpdate, client])

  const connectGateway = React.useCallback(async () => {
    const target = normalizeGatewayUrl(gatewayInput)
    setActionPending(true)
    setConnectionError('')

    try {
      await client.connect(target)
      saveGatewayUrlToStorage(target)

      const terminalPayload = await client.request<{ terminals: GatewayTerminalSummary[] }>('terminal:list', {})
      const terminals = terminalPayload.terminals || []
      if (terminals.length === 0) {
        throw new Error('No terminal is available on backend.')
      }

      let profiles: GatewayProfileSummary[] = []
      let activeProfileId = ''
      let skills: SkillSummary[] = []
      let skillsUnavailable = false
      try {
        const profilePayload = await client.request<{ activeProfileId: string; profiles: GatewayProfileSummary[] }>(
          'models:getProfiles',
          {}
        )
        profiles = profilePayload.profiles || []
        activeProfileId = profilePayload.activeProfileId || ''
      } catch {
        profiles = []
        activeProfileId = ''
      }

      try {
        skills = await fetchSkillsSnapshot(client)
      } catch {
        skills = []
        skillsUnavailable = true
      }

      const sessionPayload = await client.request<{ sessions: GatewaySessionSummary[] }>('session:list', {})
      let summaries = sessionPayload.sessions || []

      if (summaries.length === 0) {
        const created = await client.request<{ sessionId: string }>('gateway:createSession', {})
        summaries = [
          {
            id: created.sessionId,
            title: 'New Chat',
            updatedAt: Date.now(),
            messagesCount: 0,
            lastMessagePreview: '',
            isBusy: false,
            lockedProfileId: null
          }
        ]
      }

      const sortedSummaries = [...summaries].sort((left, right) => right.updatedAt - left.updatedAt)
      const initialSummary = sortedSummaries[0]
      if (!initialSummary) {
        throw new Error('No session available from gateway.')
      }

      const snapshotPayload = await client.request<{ session: GatewaySessionSnapshot }>('session:get', {
        sessionId: initialSummary.id
      })
      const snapshot = snapshotPayload.session

      const sessions: Record<string, SessionState> = {}
      const sessionMeta: Record<string, SessionMeta> = {}

      for (const summary of sortedSummaries) {
        const loaded = summary.id === snapshot.id
        const session = createSessionState(summary.id, summary.title || 'Recovered Session')
        if (loaded) {
          session.title = snapshot.title || session.title
          session.messages = (snapshot.messages || []).map(cloneMessage)
          session.isBusy = snapshot.isBusy === true
          session.isThinking = snapshot.isBusy === true
          session.lockedProfileId = snapshot.lockedProfileId || null
        } else {
          session.isBusy = summary.isBusy === true
          session.isThinking = summary.isBusy === true
          session.lockedProfileId = summary.lockedProfileId || null
        }
        sessions[summary.id] = session
        sessionMeta[summary.id] = {
          id: summary.id,
          title: loaded ? session.title : summary.title || 'Recovered Session',
          updatedAt: summary.updatedAt || Date.now(),
          messagesCount: loaded ? session.messages.length : summary.messagesCount,
          lastMessagePreview: loaded ? previewFromSession(session) : summary.lastMessagePreview,
          loaded
        }
      }

      const order = reorderSessionIds(
        sortedSummaries.map((summary) => summary.id),
        sessionMeta
      )

      setView({
        terminals,
        skills,
        profiles,
        activeProfileId,
        sessions,
        sessionMeta,
        sessionOrder: order,
        activeSessionId: snapshot.id,
        statusLine: skillsUnavailable ? `Connected: ${target} (skills unavailable)` : `Connected: ${target}`
      })
    } catch (error) {
      setConnectionError(safeError(error))
    } finally {
      setActionPending(false)
    }
  }, [client, gatewayInput])

  const disconnectGateway = React.useCallback(() => {
    client.disconnect()
    setConnectionStatus('disconnected')
    setView((previous) => ({ ...previous, statusLine: 'Disconnected by user' }))
  }, [client])

  const ensureSessionLoaded = React.useCallback(
    async (sessionId: string) => {
      const snapshotState = viewRef.current
      const currentMeta = snapshotState.sessionMeta[sessionId]
      if (currentMeta?.loaded) return

      const payload = await client.request<{ session: GatewaySessionSnapshot }>('session:get', { sessionId })
      const snapshot = payload.session

      setView((previous) => {
        const sessions = { ...previous.sessions }
        const sessionMeta = { ...previous.sessionMeta }

        const nextSession = createSessionState(sessionId, snapshot.title || 'Recovered Session')
        nextSession.messages = (snapshot.messages || []).map(cloneMessage)
        nextSession.isBusy = snapshot.isBusy === true
        nextSession.isThinking = snapshot.isBusy === true
        nextSession.lockedProfileId = snapshot.lockedProfileId || null
        sessions[sessionId] = nextSession

        sessionMeta[sessionId] = {
          id: sessionId,
          title: nextSession.title,
          updatedAt: snapshot.updatedAt || Date.now(),
          messagesCount: nextSession.messages.length,
          lastMessagePreview: previewFromSession(nextSession),
          loaded: true
        }

        return {
          ...previous,
          sessions,
          sessionMeta
        }
      })
    },
    [client]
  )

  const switchSession = React.useCallback(
    async (sessionId: string) => {
      try {
        await ensureSessionLoaded(sessionId)
        setView((previous) => ({
          ...previous,
          activeSessionId: sessionId,
          statusLine: `Session: ${compactStatusLabel(previous.sessionMeta[sessionId]?.title || sessionId)}`
        }))
      } catch (error) {
        setConnectionError(`Failed to load session: ${safeError(error)}`)
      }
    },
    [ensureSessionLoaded]
  )

  const createSessionInternal = React.useCallback(async (): Promise<{ sessionId: string } | null> => {
    if (!client.isConnected()) {
      setConnectionError('Gateway is not connected')
      return null
    }

    try {
      const payload = await client.request<{ sessionId: string }>('gateway:createSession', {})

      setView((previous) => {
        const sessions = { ...previous.sessions }
        const sessionMeta = { ...previous.sessionMeta }
        const sessionOrder = [payload.sessionId, ...previous.sessionOrder.filter((id) => id !== payload.sessionId)]
        const nextSession = createSessionState(payload.sessionId)
        sessions[payload.sessionId] = nextSession
        sessionMeta[payload.sessionId] = {
          id: payload.sessionId,
          title: nextSession.title,
          updatedAt: Date.now(),
          messagesCount: 0,
          lastMessagePreview: '',
          loaded: true
        }
        return {
          ...previous,
          sessions,
          sessionMeta,
          sessionOrder,
          activeSessionId: payload.sessionId,
          statusLine: `Created session ${payload.sessionId.slice(0, 8)}`
        }
      })

      return { sessionId: payload.sessionId }
    } catch (error) {
      setConnectionError(`Failed to create session: ${safeError(error)}`)
      return null
    }
  }, [client])

  const createSession = React.useCallback(async (): Promise<string | null> => {
    const result = await createSessionInternal()
    return result?.sessionId || null
  }, [createSessionInternal])

  const sendMessage = React.useCallback(async () => {
    const content = composerValue.trim()
    if (!content) return

    if (!client.isConnected()) {
      setConnectionError('Connect gateway first')
      return
    }

    let targetSessionId = viewRef.current.activeSessionId

    if (!targetSessionId) {
      const created = await createSessionInternal()
      if (!created) return
      targetSessionId = created.sessionId
    }

    const snapshot = viewRef.current
    const session = snapshot.sessions[targetSessionId]
    const encodedText = encodeMentions(content, snapshot.terminals, snapshot.skills)

    setComposerValueRaw('')
    setComposerCursor(0)

    setView((previous) => {
      const sessions = { ...previous.sessions }
      const current = sessions[targetSessionId!]
      if (current) {
        const copy = cloneSession(current)
        copy.isThinking = true
        copy.isBusy = true
        if (!current.isBusy) {
          copy.lockedProfileId = previous.activeProfileId || null
        }
        sessions[targetSessionId!] = copy
      }
      return {
        ...previous,
        sessions,
        statusLine: 'Prompt sent'
      }
    })

    try {
      await client.request('agent:startTaskAsync', {
        sessionId: targetSessionId,
        userText: encodedText,
        options: {
          startMode: session?.isBusy ? 'inserted' : 'normal'
        }
      })
    } catch (error) {
      setConnectionError(`Failed to send prompt: ${safeError(error)}`)
      setView((previous) => {
        const sessions = { ...previous.sessions }
        const current = sessions[targetSessionId!]
        if (current) {
          const copy = cloneSession(current)
          copy.isThinking = false
          copy.isBusy = false
          copy.lockedProfileId = null
          sessions[targetSessionId!] = copy
        }
        return {
          ...previous,
          sessions
        }
      })
    }
  }, [client, composerValue, createSessionInternal])

  const stopActiveSession = React.useCallback(async () => {
    const active = viewRef.current.activeSessionId
    if (!active) return
    try {
      await client.request('agent:stopTask', { sessionId: active })
      setView((previous) => ({ ...previous, statusLine: 'Stop signal sent' }))
    } catch (error) {
      setConnectionError(`Failed to stop: ${safeError(error)}`)
    }
  }, [client])

  const updateProfile = React.useCallback(
    async (profileId: string) => {
      if (!profileId) return
      try {
        const payload = await client.request<{
          activeProfileId: string
          profiles: GatewayProfileSummary[]
        }>('models:setActiveProfile', { profileId })

        setView((previous) => ({
          ...previous,
          profiles: payload.profiles,
          activeProfileId: payload.activeProfileId,
          statusLine: `Profile: ${payload.profiles.find((item) => item.id === payload.activeProfileId)?.name || profileId}`
        }))
      } catch (error) {
        setConnectionError(`Failed to switch profile: ${safeError(error)}`)
      }
    },
    [client]
  )

  const setSkillEnabled = React.useCallback(
    async (name: string, enabled: boolean) => {
      if (!name || !client.isConnected()) return
      try {
        const payload = await client.request<{ skills: SkillSummary[] }>('skills:setEnabled', {
          name,
          enabled
        })
        const enabledNames = collectEnabledSkillNames(payload.skills || [])
        setView((previous) => ({
          ...previous,
          skills: previous.skills.map((skill) => ({
            ...skill,
            enabled: enabledNames.has(skill.name)
          })),
          statusLine: `${enabled ? 'Enabled' : 'Disabled'} skill: ${name}`
        }))
      } catch (error) {
        setConnectionError(`Failed to update skill: ${safeError(error)}`)
      }
    },
    [client]
  )

  const reloadSkills = React.useCallback(async () => {
    if (!client.isConnected()) return
    try {
      const nextSkills = await fetchSkillsSnapshot(client)
      setView((previous) => ({
        ...previous,
        skills: mergeSkillsByName(previous.skills, nextSkills),
        statusLine: `Skills refreshed (${nextSkills.length})`
      }))
    } catch (error) {
      setConnectionError(`Failed to reload skills: ${safeError(error)}`)
    }
  }, [client])

  const replyAsk = React.useCallback(
    async (message: ChatMessage, decision: 'allow' | 'deny') => {
      const activeSessionId = viewRef.current.activeSessionId
      if (!activeSessionId) return

      try {
        if (message.metadata?.approvalId) {
          await client.request('agent:replyCommandApproval', {
            approvalId: message.metadata.approvalId,
            decision
          })
        } else {
          await client.request('agent:replyMessage', {
            messageId: message.backendMessageId || message.id,
            payload: { decision }
          })
        }

        setView((previous) => {
          const sessions = { ...previous.sessions }
          const current = sessions[activeSessionId]
          if (!current) return previous

          const copy = cloneSession(current)
          copy.messages = copy.messages.map((item) => {
            if (item.id !== message.id) return item
            return {
              ...item,
              metadata: {
                ...(item.metadata ?? {}),
                decision
              }
            }
          })
          sessions[activeSessionId] = copy

          return {
            ...previous,
            sessions,
            statusLine: `Decision sent: ${decision}`
          }
        })
      } catch (error) {
        setConnectionError(`Failed to send decision: ${safeError(error)}`)
      }
    },
    [client]
  )

  const setComposerValue = React.useCallback((value: string, cursor: number) => {
    setComposerValueRaw(value)
    setComposerCursor(cursor)
  }, [])

  const pickMention = React.useCallback(
    (option: MentionOption) => {
      const context = mentionState.context
      if (!context) return
      const next = applyMentionToInput(composerValue, context, option)
      setComposerValueRaw(next.value)
      setComposerCursor(next.cursor)
    },
    [composerValue, mentionState.context]
  )

  const reconcileTerminals = React.useCallback(
    (terminals: GatewayTerminalSummary[], statusLine: string) => {
      setView((previous) => {
        return {
          ...previous,
          terminals,
          statusLine
        }
      })
    },
    []
  )

  const createTerminalTab = React.useCallback(async () => {
    if (!client.isConnected()) {
      setConnectionError('Gateway is not connected')
      return
    }

    try {
      const snapshot = viewRef.current
      const localCount = snapshot.terminals.filter((terminal) => terminal.type === 'local').length
      const existingIds = new Set(snapshot.terminals.map((terminal) => terminal.id))
      let suffix = Math.max(2, localCount + 1)
      let nextId = `local-${suffix}`
      while (existingIds.has(nextId)) {
        suffix += 1
        nextId = `local-${suffix}`
      }

      const title = `Local (${localCount + 1})`
      await client.request<{ id: string }>('terminal:createTab', {
        config: {
          type: 'local',
          id: nextId,
          title,
          cols: 120,
          rows: 32
        }
      })

      const payload = await client.request<{ terminals: GatewayTerminalSummary[] }>('terminal:list', {})
      reconcileTerminals(payload.terminals || [], `Created terminal ${title}`)
    } catch (error) {
      setConnectionError(`Failed to create terminal: ${safeError(error)}`)
    }
  }, [client, reconcileTerminals])

  const closeTerminalTab = React.useCallback(
    async (terminalId: string) => {
      if (!terminalId) return
      if (!client.isConnected()) {
        setConnectionError('Gateway is not connected')
        return
      }

      const snapshot = viewRef.current
      if (snapshot.terminals.length <= 1) {
        setConnectionError('Cannot close the last terminal tab')
        return
      }

      try {
        await client.request('terminal:kill', { terminalId })
        const payload = await client.request<{ terminals: GatewayTerminalSummary[] }>('terminal:list', {})
        reconcileTerminals(payload.terminals || [], 'Closed terminal tab')
      } catch (error) {
        setConnectionError(`Failed to close terminal: ${safeError(error)}`)
      }
    },
    [client, reconcileTerminals]
  )

  const state: MobileControllerState = {
    gatewayInput,
    connectionStatus,
    connectionError,
    actionPending,
    composerValue,
    composerCursor,
    mentionOptions: mentionState.options,
    terminals: view.terminals,
    skills: view.skills,
    profiles: view.profiles,
    activeProfileId: view.activeProfileId,
    activeSession,
    activeSessionId: view.activeSessionId,
    chatTimeline,
    sessionOrder: view.sessionOrder,
    sessionMeta: view.sessionMeta,
    sessions: view.sessions,
    statusLine: view.statusLine,
    isRunning: !!(activeSession?.isBusy || activeSession?.isThinking),
    latestTokens: tokenUsage.totalTokens,
    latestMaxTokens: tokenUsage.maxTokens,
    tokenUsagePercent: tokenUsage.percent
  }

  const actions: MobileControllerActions = {
    setGatewayInput,
    setComposerValue,
    setComposerCursor,
    pickMention,
    connectGateway,
    disconnectGateway,
    switchSession,
    createSession,
    sendMessage,
    stopActiveSession,
    updateProfile,
    reloadSkills,
    setSkillEnabled,
    replyAsk,
    createTerminalTab,
    closeTerminalTab
  }

  return {
    state,
    actions
  }
}
