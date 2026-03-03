import type { FileSystemEntry } from '../../lib/ipcTypes'

const MAX_PREVIEW_BYTES = 1024 * 1024
const UNKNOWN_EXTENSION_MAX_PREVIEW_BYTES = 128 * 1024

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
  '.env.production'
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
  '.dockerfile'
])

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.pdf',
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
  '.bin'
])

export type PreviewUnsupportedReason = 'unsupportedType' | 'fileTooLarge'

export interface PreviewSupportDecision {
  supported: boolean
  reason?: PreviewUnsupportedReason
}

export const resolveTextPreviewSupport = (entry: FileSystemEntry): PreviewSupportDecision => {
  if (entry.isDirectory) {
    return {
      supported: false,
      reason: 'unsupportedType'
    }
  }

  const normalizedSize = Number.isFinite(entry.size) && entry.size > 0 ? Math.floor(entry.size) : 0
  if (normalizedSize > MAX_PREVIEW_BYTES) {
    return {
      supported: false,
      reason: 'fileTooLarge'
    }
  }

  const normalizedName = String(entry.name || '').toLowerCase()
  if (KNOWN_TEXT_FILENAMES.has(normalizedName)) {
    return { supported: true }
  }

  const dotIndex = normalizedName.lastIndexOf('.')
  if (dotIndex < 0) {
    return normalizedSize <= UNKNOWN_EXTENSION_MAX_PREVIEW_BYTES
      ? { supported: true }
      : { supported: false, reason: 'unsupportedType' }
  }

  const extension = normalizedName.slice(dotIndex)
  if (TEXT_EXTENSIONS.has(extension)) {
    return { supported: true }
  }
  if (BINARY_EXTENSIONS.has(extension)) {
    return {
      supported: false,
      reason: 'unsupportedType'
    }
  }

  return normalizedSize <= UNKNOWN_EXTENSION_MAX_PREVIEW_BYTES
    ? { supported: true }
    : { supported: false, reason: 'unsupportedType' }
}

export const TEXT_PREVIEW_MAX_BYTES = MAX_PREVIEW_BYTES
