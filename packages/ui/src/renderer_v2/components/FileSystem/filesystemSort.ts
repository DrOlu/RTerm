import type { FileSystemEntry } from '../../lib/ipcTypes'

export const FILESYSTEM_SORT_MODE_VALUES = [
  'name-asc',
  'name-desc',
  'modified-desc',
  'modified-asc',
  'size-desc',
  'size-asc',
  'type-asc',
  'type-desc',
] as const

export type FileSystemSortMode = (typeof FILESYSTEM_SORT_MODE_VALUES)[number]

export const DEFAULT_FILESYSTEM_SORT_MODE: FileSystemSortMode = 'name-asc'

export const isHiddenFileSystemEntry = (entry: FileSystemEntry): boolean => {
  const normalizedName = String(entry.name || '').trim()
  return normalizedName.startsWith('.') && normalizedName !== '.' && normalizedName !== '..'
}

const compareText = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })

const compareOptionalNumber = (
  left: number | null,
  right: number | null,
  direction: 'asc' | 'desc'
): number => {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  if (left === right) return 0
  return direction === 'asc' ? left - right : right - left
}

const getTypeKey = (entry: FileSystemEntry): string => {
  if (entry.isDirectory) return ''
  const trimmedName = String(entry.name || '').trim().toLowerCase()
  const dotIndex = trimmedName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex >= trimmedName.length - 1) {
    return ''
  }
  return trimmedName.slice(dotIndex + 1)
}

const getModifiedTimestamp = (entry: FileSystemEntry): number | null => {
  if (typeof entry.modifiedAt !== 'string' || entry.modifiedAt.trim().length <= 0) {
    return null
  }
  const parsed = Date.parse(entry.modifiedAt)
  return Number.isFinite(parsed) ? parsed : null
}

const compareByName = (left: FileSystemEntry, right: FileSystemEntry, direction: 'asc' | 'desc'): number => {
  const compared = compareText(left.name, right.name)
  if (compared !== 0) {
    return direction === 'asc' ? compared : -compared
  }
  return compareText(left.path, right.path)
}

export const isFileSystemSortMode = (value: string): value is FileSystemSortMode =>
  FILESYSTEM_SORT_MODE_VALUES.includes(value as FileSystemSortMode)

export const sortFileSystemEntries = (
  entries: FileSystemEntry[],
  mode: FileSystemSortMode = DEFAULT_FILESYSTEM_SORT_MODE
): FileSystemEntry[] => {
  const resolvedMode = isFileSystemSortMode(mode) ? mode : DEFAULT_FILESYSTEM_SORT_MODE
  const direction = resolvedMode.endsWith('-asc') ? 'asc' : 'desc'

  return entries.slice().sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) {
      return left.isDirectory ? -1 : 1
    }

    if (resolvedMode.startsWith('modified-')) {
      const compared = compareOptionalNumber(
        getModifiedTimestamp(left),
        getModifiedTimestamp(right),
        direction
      )
      if (compared !== 0) return compared
      return compareByName(left, right, 'asc')
    }

    if (resolvedMode.startsWith('size-')) {
      const compared = compareOptionalNumber(
        Number.isFinite(left.size) ? left.size : 0,
        Number.isFinite(right.size) ? right.size : 0,
        direction
      )
      if (compared !== 0) return compared
      return compareByName(left, right, 'asc')
    }

    if (resolvedMode.startsWith('type-')) {
      const compared = compareText(getTypeKey(left), getTypeKey(right))
      if (compared !== 0) {
        return direction === 'asc' ? compared : -compared
      }
      return compareByName(left, right, 'asc')
    }

    return compareByName(left, right, direction)
  })
}

export const filterFileSystemEntriesByHidden = (
  entries: FileSystemEntry[],
  showHiddenFiles: boolean
): FileSystemEntry[] => {
  if (showHiddenFiles) {
    return entries.slice()
  }
  return entries.filter((entry) => !isHiddenFileSystemEntry(entry))
}
