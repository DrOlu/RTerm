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
  BuiltInToolSummary,
  ChatMessage,
  GatewayProfileSummary,
  GatewaySessionSnapshot,
  GatewaySessionSummary,
  McpServerSummary,
  SkillSummary,
  GatewayTerminalSummary,
  UIUpdateAction
} from '../types'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

interface ViewState {
  terminals: GatewayTerminalSummary[]
  skills: SkillSummary[]
  mcpTools: McpServerSummary[]
  builtInTools: BuiltInToolSummary[]
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
  mcpTools: [],
  builtInTools: [],
  profiles: [],
  activeProfileId: '',
  sessions: {},
  sessionMeta: {},
  sessionOrder: [],
  activeSessionId: null,
  statusLine: 'Ready'
}

const RECONNECT_BASE_DELAY_MS = 800
const RECONNECT_MAX_DELAY_MS = 15000
const RECONNECT_JITTER_MS = 500
const HEARTBEAT_INTERVAL_MS = 25000
const HEARTBEAT_RPC_TIMEOUT_MS = 5000
const HEARTBEAT_MAX_FAILURES = 2

function computeReconnectDelayMs(attempt: number): number {
  const exponential = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), RECONNECT_MAX_DELAY_MS)
  const jitter = Math.floor(Math.random() * (RECONNECT_JITTER_MS + 1))
  return exponential + jitter
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

function normalizeMcpServer(raw: unknown): McpServerSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  if (typeof item.name !== 'string' || !item.name) return null
  const statusRaw = item.status
  const status: McpServerSummary['status'] =
    statusRaw === 'disabled' || statusRaw === 'connecting' || statusRaw === 'connected' || statusRaw === 'error'
      ? statusRaw
      : 'disabled'
  return {
    name: item.name,
    enabled: item.enabled !== false,
    status,
    error: typeof item.error === 'string' ? item.error : undefined,
    toolCount: typeof item.toolCount === 'number' ? item.toolCount : undefined
  }
}

function normalizeBuiltInTool(raw: unknown): BuiltInToolSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  if (typeof item.name !== 'string' || !item.name) return null
  return {
    name: item.name,
    description: typeof item.description === 'string' ? item.description : 'No description provided.',
    enabled: item.enabled !== false
  }
}

async function fetchToolsSnapshot(client: GatewayClient): Promise<{
  mcpTools: McpServerSummary[]
  builtInTools: BuiltInToolSummary[]
}> {
  const [mcpRaw, builtInRaw] = await Promise.all([
    client.request<unknown>('tools:getMcp', {}),
    client.request<unknown>('tools:getBuiltIn', {})
  ])

  const mcpTools = Array.isArray(mcpRaw)
    ? mcpRaw.map((item) => normalizeMcpServer(item)).filter((item): item is McpServerSummary => !!item)
    : []
  const builtInTools = Array.isArray(builtInRaw)
    ? builtInRaw.map((item) => normalizeBuiltInTool(item)).filter((item): item is BuiltInToolSummary => !!item)
    : []

  return { mcpTools, builtInTools }
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
  mcpTools: McpServerSummary[]
  builtInTools: BuiltInToolSummary[]
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
  reloadTools: () => Promise<void>
  setMcpEnabled: (name: string, enabled: boolean) => Promise<void>
  setBuiltInToolEnabled: (name: string, enabled: boolean) => Promise<void>
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
  const gatewayInputRef = React.useRef(gatewayInput)
  React.useEffect(() => {
    gatewayInputRef.current = gatewayInput
  }, [gatewayInput])

  const reconnectTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectInFlightRef = React.useRef(false)
  const reconnectAttemptRunnerRef = React.useRef<() => Promise<void>>(async () => {})
  const reconnectAttemptRef = React.useRef(0)
  const connectFlowRef = React.useRef<Promise<void> | null>(null)
  const heartbeatTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const heartbeatInFlightRef = React.useRef(false)
  const heartbeatFailuresRef = React.useRef(0)
  const manualDisconnectRef = React.useRef(false)
  const autoReconnectEnabledRef = React.useRef(false)
  const hasEverConnectedRef = React.useRef(false)
  const lastConnectedAtRef = React.useRef(0)

  const clearReconnectTimer = React.useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

  const stopHeartbeat = React.useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current)
      heartbeatTimerRef.current = null
    }
    heartbeatInFlightRef.current = false
    heartbeatFailuresRef.current = 0
  }, [])

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

  const bootstrapAfterConnect = React.useCallback(
    async (target: string, source: 'manual' | 'reconnect') => {
      const terminalPayload = await client.request<{ terminals: GatewayTerminalSummary[] }>('terminal:list', {})
      const terminals = terminalPayload.terminals || []
      if (terminals.length === 0) {
        throw new Error('No terminal is available on backend.')
      }

      let profiles: GatewayProfileSummary[] = []
      let activeProfileId = ''
      let skills: SkillSummary[] = []
      let skillsUnavailable = false
      let mcpTools: McpServerSummary[] = []
      let builtInTools: BuiltInToolSummary[] = []
      let toolsUnavailable = false
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

      try {
        const toolsSnapshot = await fetchToolsSnapshot(client)
        mcpTools = toolsSnapshot.mcpTools
        builtInTools = toolsSnapshot.builtInTools
      } catch {
        mcpTools = []
        builtInTools = []
        toolsUnavailable = true
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
      const previous = viewRef.current
      const preferredSummary = sortedSummaries.find((item) => item.id === previous.activeSessionId) || sortedSummaries[0]
      if (!preferredSummary) {
        throw new Error('No session available from gateway.')
      }

      const mustLoadSnapshotIds = new Set<string>([
        preferredSummary.id,
        ...sortedSummaries.filter((item) => item.isBusy).map((item) => item.id)
      ])
      const loadedSnapshots = new Map<string, GatewaySessionSnapshot>()
      await Promise.all(
        [...mustLoadSnapshotIds].map(async (sessionId) => {
          try {
            const payload = await client.request<{ session: GatewaySessionSnapshot }>('session:get', { sessionId })
            loadedSnapshots.set(sessionId, payload.session)
          } catch (error) {
            if (sessionId === preferredSummary.id) {
              throw error
            }
          }
        })
      )

      const sessions: Record<string, SessionState> = {}
      const sessionMeta: Record<string, SessionMeta> = {}
      const activeSessionId = loadedSnapshots.has(preferredSummary.id) ? preferredSummary.id : sortedSummaries[0]?.id || null

      for (const summary of sortedSummaries) {
        const snapshot = loadedSnapshots.get(summary.id)
        const loaded = !!snapshot
        const session = createSessionState(summary.id, summary.title || 'Recovered Session')
        if (snapshot) {
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
        mcpTools,
        builtInTools,
        profiles,
        activeProfileId,
        sessions,
        sessionMeta,
        sessionOrder: order,
        activeSessionId,
        statusLine:
          source === 'reconnect'
            ? `Recovered: ${target}`
            : skillsUnavailable || toolsUnavailable
              ? `Connected: ${target} (skills unavailable)`
              : `Connected: ${target}`
      })
    },
    [client]
  )

  const scheduleReconnect = React.useCallback(
    (reason: string, immediate = false) => {
      if (manualDisconnectRef.current || !autoReconnectEnabledRef.current || !hasEverConnectedRef.current) return
      if (client.isConnected()) return
      clearReconnectTimer()

      if (!window.navigator.onLine) {
        setView((previous) => ({ ...previous, statusLine: 'Offline. Waiting for network...' }))
        return
      }

      const nextAttempt = reconnectAttemptRef.current + 1
      const delay = immediate ? 0 : computeReconnectDelayMs(nextAttempt)
      reconnectAttemptRef.current = nextAttempt
      setView((previous) => ({
        ...previous,
        statusLine: immediate
          ? `Reconnecting now (${nextAttempt})...`
          : `Disconnected: ${reason}. Reconnecting in ${Math.max(1, Math.ceil(delay / 1000))}s (${nextAttempt})...`
      }))

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null
        void reconnectAttemptRunnerRef.current()
      }, delay)
    },
    [clearReconnectTimer, client]
  )

  const startHeartbeat = React.useCallback(() => {
    stopHeartbeat()
    if (!client.isConnected()) return

    heartbeatTimerRef.current = setInterval(() => {
      if (heartbeatInFlightRef.current || !client.isConnected()) return
      heartbeatInFlightRef.current = true
      void client
        .request('gateway:ping', {}, HEARTBEAT_RPC_TIMEOUT_MS)
        .then(() => {
          heartbeatFailuresRef.current = 0
        })
        .catch(() => {
          heartbeatFailuresRef.current += 1
          if (heartbeatFailuresRef.current >= HEARTBEAT_MAX_FAILURES) {
            stopHeartbeat()
            setConnectionError('Gateway heartbeat lost. Reconnecting...')
            try {
              client.disconnect()
            } catch {
              // ignore disconnect errors
            }
            scheduleReconnect('heartbeat lost', true)
          }
        })
        .finally(() => {
          heartbeatInFlightRef.current = false
        })
    }, HEARTBEAT_INTERVAL_MS)
  }, [client, scheduleReconnect, stopHeartbeat])

  const runConnectFlow = React.useCallback(
    async (target: string, source: 'manual' | 'reconnect') => {
      if (connectFlowRef.current) {
        await connectFlowRef.current
        return
      }
      const flow = (async () => {
        await client.connect(target)
        if (source === 'manual') {
          saveGatewayUrlToStorage(target)
        }
        await bootstrapAfterConnect(target, source)
        lastConnectedAtRef.current = Date.now()
        hasEverConnectedRef.current = true
        reconnectAttemptRef.current = 0
        clearReconnectTimer()
        reconnectInFlightRef.current = false
        startHeartbeat()
      })()
      connectFlowRef.current = flow.finally(() => {
        connectFlowRef.current = null
      })
      await connectFlowRef.current
    },
    [bootstrapAfterConnect, clearReconnectTimer, client, startHeartbeat]
  )

  const runAutoReconnectAttempt = React.useCallback(async () => {
    if (reconnectInFlightRef.current) return
    if (manualDisconnectRef.current || !autoReconnectEnabledRef.current || !hasEverConnectedRef.current) return
    if (!window.navigator.onLine) {
      setView((previous) => ({ ...previous, statusLine: 'Offline. Waiting for network...' }))
      return
    }

    reconnectInFlightRef.current = true
    const target = normalizeGatewayUrl(gatewayInputRef.current)
    try {
      setConnectionError('')
      await runConnectFlow(target, 'reconnect')
    } catch (error) {
      reconnectInFlightRef.current = false
      scheduleReconnect(safeError(error))
    }
  }, [runConnectFlow, scheduleReconnect])
  reconnectAttemptRunnerRef.current = runAutoReconnectAttempt

  React.useEffect(() => {
    const unsubscribers = [
      client.on('status', (status, detail) => {
        const currentReconnectAttempt = reconnectAttemptRef.current
        setConnectionStatus(status)
        if (status === 'connecting') {
          setConnectionError('')
          setView((previous) => ({
            ...previous,
            statusLine:
              currentReconnectAttempt > 0
                ? `Reconnecting gateway... (${currentReconnectAttempt})`
                : 'Connecting gateway...'
          }))
        }
        if (status === 'connected') {
          setConnectionError('')
          setView((previous) => ({
            ...previous,
            statusLine:
              currentReconnectAttempt > 0
                ? `Gateway reconnected (${currentReconnectAttempt})`
                : 'Gateway connected'
          }))
        }
        if (status === 'disconnected') {
          stopHeartbeat()
          const reason = detail || 'connection closed'
          if (manualDisconnectRef.current) {
            setView((previous) => ({ ...previous, statusLine: 'Disconnected by user' }))
            return
          }
          if (!window.navigator.onLine) {
            setView((previous) => ({ ...previous, statusLine: 'Offline. Waiting for network...' }))
            return
          }
          setView((previous) => ({ ...previous, statusLine: `Disconnected: ${reason}` }))
          scheduleReconnect(reason)
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
          const nextMcpTools = Array.isArray(payload)
            ? payload.map((item) => normalizeMcpServer(item)).filter((item): item is McpServerSummary => !!item)
            : []
          setView((previous) => ({
            ...previous,
            mcpTools: nextMcpTools,
            statusLine: `MCP tools updated (${nextMcpTools.length})`
          }))
          return
        }

        if (channel === 'tools:builtInUpdated') {
          const nextBuiltInTools = Array.isArray(payload)
            ? payload.map((item) => normalizeBuiltInTool(item)).filter((item): item is BuiltInToolSummary => !!item)
            : []
          setView((previous) => ({
            ...previous,
            builtInTools: nextBuiltInTools,
            statusLine: `Built-in tools updated (${nextBuiltInTools.length})`
          }))
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
      clearReconnectTimer()
      stopHeartbeat()
      autoReconnectEnabledRef.current = false
      manualDisconnectRef.current = true
      client.disconnect()
    }
  }, [applyLiveUpdate, clearReconnectTimer, client, scheduleReconnect, stopHeartbeat])

  React.useEffect(() => {
    const onOffline = () => {
      clearReconnectTimer()
      setView((previous) => ({ ...previous, statusLine: 'Offline. Waiting for network...' }))
    }
    const onOnline = () => {
      if (manualDisconnectRef.current || !autoReconnectEnabledRef.current || !hasEverConnectedRef.current) return
      if (client.isConnected()) return
      scheduleReconnect('network restored', true)
    }
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [clearReconnectTimer, client, scheduleReconnect])

  const connectGateway = React.useCallback(async () => {
    const target = normalizeGatewayUrl(gatewayInput)
    setActionPending(true)
    setConnectionError('')
    manualDisconnectRef.current = false
    autoReconnectEnabledRef.current = true
    reconnectInFlightRef.current = false
    reconnectAttemptRef.current = 0
    clearReconnectTimer()

    try {
      await runConnectFlow(target, 'manual')
    } catch (error) {
      setConnectionError(safeError(error))
      scheduleReconnect(safeError(error))
    } finally {
      setActionPending(false)
    }
  }, [clearReconnectTimer, gatewayInput, runConnectFlow, scheduleReconnect])

  const disconnectGateway = React.useCallback(() => {
    manualDisconnectRef.current = true
    autoReconnectEnabledRef.current = false
    reconnectInFlightRef.current = false
    reconnectAttemptRef.current = 0
    clearReconnectTimer()
    stopHeartbeat()
    client.disconnect()
    setConnectionStatus('disconnected')
    setConnectionError('')
    setView((previous) => ({ ...previous, statusLine: 'Disconnected by user' }))
  }, [clearReconnectTimer, client, stopHeartbeat])

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
      setConnectionError(
        connectionStatus === 'connecting'
          ? 'Gateway is reconnecting. Please wait and retry.'
          : 'Gateway is disconnected. Please wait for reconnection.'
      )
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
  }, [client, composerValue, connectionStatus, createSessionInternal])

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

  const setMcpEnabled = React.useCallback(
    async (name: string, enabled: boolean) => {
      if (!name || !client.isConnected()) return
      try {
        const payload = await client.request<unknown>('tools:setMcpEnabled', { name, enabled })
        const nextMcpTools = Array.isArray(payload)
          ? payload.map((item) => normalizeMcpServer(item)).filter((item): item is McpServerSummary => !!item)
          : []
        setView((previous) => ({
          ...previous,
          mcpTools: nextMcpTools,
          statusLine: `${enabled ? 'Enabled' : 'Disabled'} MCP: ${name}`
        }))
      } catch (error) {
        setConnectionError(`Failed to update MCP server: ${safeError(error)}`)
      }
    },
    [client]
  )

  const setBuiltInToolEnabled = React.useCallback(
    async (name: string, enabled: boolean) => {
      if (!name || !client.isConnected()) return
      try {
        const payload = await client.request<unknown>('tools:setBuiltInEnabled', { name, enabled })
        const nextBuiltInTools = Array.isArray(payload)
          ? payload.map((item) => normalizeBuiltInTool(item)).filter((item): item is BuiltInToolSummary => !!item)
          : []
        setView((previous) => ({
          ...previous,
          builtInTools: nextBuiltInTools,
          statusLine: `${enabled ? 'Enabled' : 'Disabled'} built-in tool: ${name}`
        }))
      } catch (error) {
        setConnectionError(`Failed to update built-in tool: ${safeError(error)}`)
      }
    },
    [client]
  )

  const reloadTools = React.useCallback(async () => {
    if (!client.isConnected()) return
    try {
      const snapshot = await fetchToolsSnapshot(client)
      setView((previous) => ({
        ...previous,
        mcpTools: snapshot.mcpTools,
        builtInTools: snapshot.builtInTools,
        statusLine: `Tools refreshed (${snapshot.mcpTools.length + snapshot.builtInTools.length})`
      }))
    } catch (error) {
      setConnectionError(`Failed to reload tools: ${safeError(error)}`)
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
    mcpTools: view.mcpTools,
    builtInTools: view.builtInTools,
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
    reloadTools,
    setMcpEnabled,
    setBuiltInToolEnabled,
    replyAsk,
    createTerminalTab,
    closeTerminalTab
  }

  return {
    state,
    actions
  }
}
