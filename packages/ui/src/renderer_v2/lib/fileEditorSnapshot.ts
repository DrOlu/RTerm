export type FileEditorSnapshotMode = 'idle' | 'loading' | 'text' | 'error'

export interface FileEditorSnapshot {
  terminalId: string | null
  filePath: string | null
  mode: FileEditorSnapshotMode
  content: string
  dirty: boolean
  errorMessage: string | null
  statusMessage: string | null
}

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

const normalizeMode = (value: unknown): FileEditorSnapshotMode | null => {
  if (value === 'idle' || value === 'loading' || value === 'text' || value === 'error') {
    return value
  }
  return null
}

export const normalizeFileEditorSnapshot = (value: unknown): FileEditorSnapshot | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<FileEditorSnapshot>
  const mode = normalizeMode(raw.mode)
  if (!mode) return null

  const hasDocument = mode === 'loading' || mode === 'text' || mode === 'error'
  const terminalId = hasDocument ? normalizeOptionalString(raw.terminalId) : null
  const filePath = hasDocument ? normalizeOptionalString(raw.filePath) : null
  if (hasDocument && (!terminalId || !filePath)) {
    return null
  }

  return {
    terminalId,
    filePath,
    mode,
    content: typeof raw.content === 'string' ? raw.content : '',
    dirty: mode === 'text' && raw.dirty === true,
    errorMessage: normalizeOptionalString(raw.errorMessage),
    statusMessage: normalizeOptionalString(raw.statusMessage)
  }
}
