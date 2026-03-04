export const FILESYSTEM_PANEL_DRAG_MIME = 'application/x-gyshell-filesystem-items'

export interface FileSystemPanelDragEntry {
  name: string
  path: string
  isDirectory: boolean
  size?: number
}

export interface FileSystemPanelDragPayload {
  version: 1
  sourceTerminalId: string
  sourceBasePath: string
  entries: FileSystemPanelDragEntry[]
}

export interface TerminalScopedFilePath {
  terminalId: string
  filePath: string
}

const TERMINAL_SCOPED_FILE_PATTERN = /^@terminal\(([^)]+)\):(.*)$/

const collectUniquePaths = (paths: Array<string | null | undefined>): string[] => {
  const seen = new Set<string>()
  const next: string[] = []
  for (const candidate of paths) {
    const normalized = typeof candidate === 'string' ? candidate.trim() : ''
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    next.push(normalized)
  }
  return next
}

export const encodeFileSystemPanelDragPayload = (payload: FileSystemPanelDragPayload): string =>
  JSON.stringify(payload)

export const parseFileSystemPanelDragPayload = (
  dataTransfer: Pick<DataTransfer, 'types' | 'getData'> | null | undefined
): FileSystemPanelDragPayload | null => {
  if (!dataTransfer) return null
  const types = Array.from(dataTransfer.types || [])
  if (!types.includes(FILESYSTEM_PANEL_DRAG_MIME)) return null
  const raw = dataTransfer.getData(FILESYSTEM_PANEL_DRAG_MIME)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<FileSystemPanelDragPayload>
    if (parsed?.version !== 1) return null
    const sourceTerminalId = typeof parsed.sourceTerminalId === 'string' ? parsed.sourceTerminalId.trim() : ''
    if (!sourceTerminalId) return null
    const sourceBasePath = typeof parsed.sourceBasePath === 'string' ? parsed.sourceBasePath : '.'
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries
          .map((entry) => {
            if (!entry || typeof entry !== 'object') return null
            const name = typeof (entry as any).name === 'string' ? (entry as any).name : ''
            const path = typeof (entry as any).path === 'string' ? (entry as any).path : ''
            if (!name || !path) return null
            const isDirectory = (entry as any).isDirectory === true
            const size = Number.isFinite((entry as any).size) ? Math.max(0, Math.floor((entry as any).size)) : undefined
            return {
              name,
              path,
              isDirectory,
              ...(typeof size === 'number' ? { size } : {})
            } satisfies FileSystemPanelDragEntry
          })
          .filter((entry): entry is FileSystemPanelDragEntry => !!entry)
      : []
    if (entries.length <= 0) return null
    return {
      version: 1,
      sourceTerminalId,
      sourceBasePath,
      entries
    }
  } catch {
    return null
  }
}

export const hasFileSystemPanelDragPayloadType = (
  dataTransfer: Pick<DataTransfer, 'types'> | null | undefined
): boolean => {
  if (!dataTransfer) return false
  const types = Array.from(dataTransfer.types || [])
  return types.includes(FILESYSTEM_PANEL_DRAG_MIME)
}

export const hasNativeFileDragType = (
  dataTransfer: Pick<DataTransfer, 'types'> | null | undefined
): boolean => {
  if (!dataTransfer) return false
  const types = Array.from(dataTransfer.types || [])
  return types.includes('Files')
}

export const extractNativeDropFilePaths = (
  dataTransfer: Pick<DataTransfer, 'files'> | null | undefined
): string[] => {
  if (!dataTransfer?.files) return []
  const paths = Array.from(dataTransfer.files).map((file) => {
    return typeof (file as File & { path?: unknown }).path === 'string'
      ? String((file as File & { path?: string }).path)
      : ''
  })
  return collectUniquePaths(paths)
}

export const extractFileSystemPayloadPaths = (
  dataTransfer: Pick<DataTransfer, 'types' | 'getData'> | null | undefined
): string[] => {
  const payload = parseFileSystemPanelDragPayload(dataTransfer)
  if (!payload) return []
  return collectUniquePaths(payload.entries.map((entry) => entry.path))
}

export const resolveTerminalDropPaths = (
  dataTransfer: Pick<DataTransfer, 'types' | 'getData' | 'files'> | null | undefined
): string[] => {
  const payloadPaths = extractFileSystemPayloadPaths(dataTransfer)
  if (payloadPaths.length > 0) {
    return payloadPaths
  }
  return extractNativeDropFilePaths(dataTransfer)
}

export const resolveTerminalDropPathsForTarget = (
  dataTransfer: Pick<DataTransfer, 'types' | 'getData' | 'files'> | null | undefined,
  targetTerminalId: string
): string[] => {
  const payload = parseFileSystemPanelDragPayload(dataTransfer)
  if (payload) {
    const normalizedTargetId = String(targetTerminalId || '').trim()
    if (normalizedTargetId && payload.sourceTerminalId !== normalizedTargetId) {
      return []
    }
    return collectUniquePaths(payload.entries.map((entry) => entry.path))
  }
  return extractNativeDropFilePaths(dataTransfer)
}

export const encodeTerminalScopedFilePath = (terminalId: string, filePath: string): string => {
  const normalizedTerminalId = String(terminalId || '').trim()
  if (!normalizedTerminalId) return filePath
  return `@terminal(${encodeURIComponent(normalizedTerminalId)}):${filePath}`
}

export const decodeTerminalScopedFilePath = (rawPath: string): TerminalScopedFilePath | null => {
  const normalized = String(rawPath || '').trim()
  if (!normalized) return null
  const matched = normalized.match(TERMINAL_SCOPED_FILE_PATTERN)
  if (!matched) return null
  const terminalIdEncoded = String(matched[1] || '').trim()
  const filePath = String(matched[2] || '')
  if (!terminalIdEncoded || !filePath) return null
  try {
    const terminalId = decodeURIComponent(terminalIdEncoded)
    if (!terminalId) return null
    return {
      terminalId,
      filePath
    }
  } catch {
    return null
  }
}

export const getFileMentionDisplayName = (rawPath: string): string => {
  const normalized = decodeTerminalScopedFilePath(rawPath)?.filePath || rawPath
  const trimmed = String(normalized || '').trim()
  if (!trimmed) return ''
  return trimmed.split(/[/\\]/).pop() || trimmed
}
