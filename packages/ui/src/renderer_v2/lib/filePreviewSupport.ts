import type { FileSystemEntry } from './ipcTypes'

const MAX_PREVIEW_BYTES = 1024 * 1024
const UNKNOWN_EXTENSION_MAX_PREVIEW_BYTES = 128 * 1024
const MAX_MEDIA_PREVIEW_BYTES = 32 * 1024 * 1024

const KNOWN_TEXT_FILENAMES = new Set([
  'makefile',
  'dockerfile',
  '.gitignore',
  '.gitattributes',
  '.npmrc',
  '.yarnrc',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
])

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.csv',
  '.tsv',
  '.ini',
  '.cfg',
  '.conf',
  '.log',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.fish',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.vue',
  '.svelte',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.php',
  '.rb',
  '.swift',
  '.sql',
  '.proto',
  '.dockerfile',
])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.avif'])

const PDF_EXTENSIONS = new Set(['.pdf'])

const BINARY_EXTENSIONS = new Set([
  '.zip',
  '.gz',
  '.tar',
  '.7z',
  '.rar',
  '.mp3',
  '.wav',
  '.flac',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.wasm',
  '.class',
  '.jar',
  '.pyc',
  '.o',
  '.a',
  '.bin',
])

export type FilePreviewKind = 'text' | 'image' | 'pdf'
export type PreviewUnsupportedReason = 'unsupportedType' | 'fileTooLarge'

export interface PreviewSupportDecision {
  supported: boolean
  kind?: FilePreviewKind
  reason?: PreviewUnsupportedReason
}

const getLowercaseExtension = (fileName: string): string | null => {
  const normalizedName = String(fileName || '').toLowerCase()
  const dotIndex = normalizedName.lastIndexOf('.')
  if (dotIndex < 0) return null
  return normalizedName.slice(dotIndex)
}

const resolveKnownPreviewKind = (fileName: string): FilePreviewKind | null => {
  const normalizedName = String(fileName || '').toLowerCase()
  if (KNOWN_TEXT_FILENAMES.has(normalizedName)) {
    return 'text'
  }

  const extension = getLowercaseExtension(normalizedName)
  if (!extension) {
    return null
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return 'text'
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image'
  }
  if (PDF_EXTENSIONS.has(extension)) {
    return 'pdf'
  }
  return null
}

export const resolveFilePreviewKindForPath = (filePath: string): FilePreviewKind => {
  return resolveKnownPreviewKind(filePath) || 'text'
}

export const resolveFilePreviewSupport = (entry: FileSystemEntry): PreviewSupportDecision => {
  if (entry.isDirectory) {
    return {
      supported: false,
      reason: 'unsupportedType',
    }
  }

  const normalizedSize = Number.isFinite(entry.size) && entry.size > 0 ? Math.floor(entry.size) : 0

  const normalizedName = String(entry.name || '').toLowerCase()
  if (KNOWN_TEXT_FILENAMES.has(normalizedName)) {
    return normalizedSize <= MAX_PREVIEW_BYTES
      ? { supported: true, kind: 'text' }
      : { supported: false, kind: 'text', reason: 'fileTooLarge' }
  }

  const extension = getLowercaseExtension(normalizedName)
  if (!extension) {
    return normalizedSize <= UNKNOWN_EXTENSION_MAX_PREVIEW_BYTES
      ? { supported: true, kind: 'text' }
      : { supported: false, reason: 'unsupportedType' }
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    return normalizedSize <= MAX_PREVIEW_BYTES
      ? { supported: true, kind: 'text' }
      : { supported: false, kind: 'text', reason: 'fileTooLarge' }
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return normalizedSize <= MAX_MEDIA_PREVIEW_BYTES
      ? { supported: true, kind: 'image' }
      : { supported: false, kind: 'image', reason: 'fileTooLarge' }
  }
  if (PDF_EXTENSIONS.has(extension)) {
    return normalizedSize <= MAX_MEDIA_PREVIEW_BYTES
      ? { supported: true, kind: 'pdf' }
      : { supported: false, kind: 'pdf', reason: 'fileTooLarge' }
  }
  if (BINARY_EXTENSIONS.has(extension)) {
    return {
      supported: false,
      reason: 'unsupportedType',
    }
  }

  return normalizedSize <= UNKNOWN_EXTENSION_MAX_PREVIEW_BYTES
    ? { supported: true, kind: 'text' }
    : { supported: false, reason: 'unsupportedType' }
}

export const resolveTextPreviewSupport = (entry: FileSystemEntry): PreviewSupportDecision => {
  const decision = resolveFilePreviewSupport(entry)
  return decision.kind === 'text' ? decision : { supported: false, reason: decision.reason || 'unsupportedType' }
}

export const TEXT_PREVIEW_MAX_BYTES = MAX_PREVIEW_BYTES
export const MEDIA_PREVIEW_MAX_BYTES = MAX_MEDIA_PREVIEW_BYTES
