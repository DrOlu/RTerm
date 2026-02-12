import type { BackendSettings, UiSettings } from '../../types'
import { BUILTIN_TOOL_INFO } from '../AgentHelper/tools'
import { deepMerge, isObject } from './objectMerge'

export const BACKEND_SETTINGS_SCHEMA_VERSION = 3
export const UI_SETTINGS_SCHEMA_VERSION = 1

const DEFAULT_BUILTIN_TOOLS = BUILTIN_TOOL_INFO.reduce((acc: Record<string, boolean>, tool) => {
  acc[tool.name] = true
  return acc
}, {})

export const DEFAULT_BACKEND_SETTINGS: BackendSettings = {
  schemaVersion: BACKEND_SETTINGS_SCHEMA_VERSION,
  commandPolicyMode: 'standard',
  tools: {
    builtIn: DEFAULT_BUILTIN_TOOLS,
    skills: {}
  },
  model: '',
  baseUrl: '',
  apiKey: '',
  models: {
    items: [],
    profiles: [],
    activeProfileId: ''
  },
  connections: {
    ssh: [],
    proxies: [],
    tunnels: []
  },
  layout: {
    panelSizes: [30, 70],
    panelOrder: ['chat', 'terminal']
  },
  recursionLimit: 200,
  debugMode: false,
  experimental: {
    runtimeThinkingCorrectionEnabled: true,
    taskFinishGuardEnabled: true,
    firstTurnThinkingModelEnabled: false
  }
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  uiSchemaVersion: UI_SETTINGS_SCHEMA_VERSION,
  language: 'en',
  themeId: 'gyshell-dark',
  terminal: {
    fontSize: 14,
    lineHeight: 1.2,
    scrollback: 5000,
    cursorStyle: 'block',
    cursorBlink: true,
    copyOnSelect: true,
    rightClickToPaste: true
  }
}

function pickBackendSnapshot(raw: unknown): Partial<BackendSettings> {
  if (!isObject(raw)) return {}
  return {
    schemaVersion: raw.schemaVersion,
    commandPolicyMode: raw.commandPolicyMode,
    model: raw.model,
    baseUrl: raw.baseUrl,
    apiKey: raw.apiKey,
    models: raw.models,
    connections: raw.connections,
    tools: raw.tools,
    layout: raw.layout,
    recursionLimit: raw.recursionLimit,
    debugMode: raw.debugMode,
    experimental: raw.experimental
  } as Partial<BackendSettings>
}

function pickUiSnapshot(raw: unknown): Partial<UiSettings> {
  if (!isObject(raw)) return {}
  return {
    uiSchemaVersion: raw.uiSchemaVersion,
    language: raw.language,
    themeId: raw.themeId,
    terminal: raw.terminal
  } as Partial<UiSettings>
}

function normalizeBackendSettings(settings: BackendSettings): BackendSettings {
  const next = deepMerge(DEFAULT_BACKEND_SETTINGS, settings)

  next.models.items = next.models.items.map((item) => ({
    ...item,
    maxTokens: typeof item.maxTokens === 'number' && item.maxTokens > 0 ? item.maxTokens : 200000
  }))

  const builtIn = { ...(next.tools?.builtIn ?? {}) }
  if (builtIn.send_char !== undefined && builtIn.write_stdin === undefined) {
    builtIn.write_stdin = builtIn.send_char
  }
  delete builtIn.send_char

  next.tools = {
    builtIn: {
      ...DEFAULT_BUILTIN_TOOLS,
      ...builtIn
    },
    skills: {
      ...(next.tools?.skills ?? {})
    }
  }

  if (!next.models.activeProfileId && next.models.profiles.length > 0) {
    next.models.activeProfileId = next.models.profiles[0].id
  }

  const activeProfile = next.models.profiles.find((profile) => profile.id === next.models.activeProfileId)
  const activeModel = activeProfile
    ? next.models.items.find((item) => item.id === activeProfile.globalModelId)
    : undefined

  next.model = activeModel?.model || ''
  next.baseUrl = activeModel?.baseUrl || ''
  next.apiKey = activeModel?.apiKey || ''

  next.recursionLimit =
    typeof next.recursionLimit === 'number' && Number.isFinite(next.recursionLimit) && next.recursionLimit > 0
      ? next.recursionLimit
      : 200

  next.debugMode = next.debugMode === true

  next.experimental = {
    runtimeThinkingCorrectionEnabled: next.experimental?.runtimeThinkingCorrectionEnabled !== false,
    taskFinishGuardEnabled: next.experimental?.taskFinishGuardEnabled !== false,
    firstTurnThinkingModelEnabled: next.experimental?.firstTurnThinkingModelEnabled === true
  }

  next.schemaVersion = BACKEND_SETTINGS_SCHEMA_VERSION
  return next
}

function normalizeUiSettings(settings: UiSettings): UiSettings {
  const next = deepMerge(DEFAULT_UI_SETTINGS, settings)
  if (typeof next.terminal.lineHeight !== 'number' || next.terminal.lineHeight < 1) {
    next.terminal.lineHeight = 1.2
  }
  if (typeof next.terminal.fontSize !== 'number' || next.terminal.fontSize < 6) {
    next.terminal.fontSize = 14
  }
  if (typeof next.terminal.scrollback !== 'number' || next.terminal.scrollback < 0) {
    next.terminal.scrollback = 5000
  }
  next.uiSchemaVersion = UI_SETTINGS_SCHEMA_VERSION
  return next
}

function migrateBackendToV3(settings: Partial<BackendSettings>): Partial<BackendSettings> {
  const next = { ...(settings as any) }
  delete (next as any).language
  delete (next as any).themeId
  delete (next as any).terminal
  next.schemaVersion = BACKEND_SETTINGS_SCHEMA_VERSION
  return next
}

function migrateUiToV1(settings: Partial<UiSettings>): Partial<UiSettings> {
  const next = { ...(settings as any) }
  next.uiSchemaVersion = UI_SETTINGS_SCHEMA_VERSION
  return next
}

export function migrateBackendSettings(raw: unknown, legacyRaw?: unknown): BackendSettings {
  const legacySnapshot = pickBackendSnapshot(legacyRaw)
  const rawSnapshot = pickBackendSnapshot(raw)

  const rawVersion = isObject(raw) && typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0
  const legacyVersion = isObject(legacyRaw) && typeof legacyRaw.schemaVersion === 'number' ? legacyRaw.schemaVersion : 0

  let merged = deepMerge(DEFAULT_BACKEND_SETTINGS, legacySnapshot)
  merged = deepMerge(merged, rawSnapshot)

  const fromVersion = Math.max(rawVersion, legacyVersion)
  if (fromVersion < BACKEND_SETTINGS_SCHEMA_VERSION) {
    merged = deepMerge(merged, migrateBackendToV3(merged as any) as any)
  }

  return normalizeBackendSettings(merged)
}

export function migrateUiSettings(raw: unknown, legacyRaw?: unknown): UiSettings {
  const legacySnapshot = pickUiSnapshot(legacyRaw)
  const rawSnapshot = pickUiSnapshot(raw)

  const rawVersion =
    isObject(raw) && typeof raw.uiSchemaVersion === 'number' ? raw.uiSchemaVersion : 0

  let merged = deepMerge(DEFAULT_UI_SETTINGS, legacySnapshot)
  merged = deepMerge(merged, rawSnapshot)

  if (rawVersion < UI_SETTINGS_SCHEMA_VERSION) {
    merged = deepMerge(merged, migrateUiToV1(merged as any) as any)
  }

  return normalizeUiSettings(merged)
}
