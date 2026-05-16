import type { FileSystemEntry } from '../../lib/ipcTypes'
import {
  DEFAULT_FILESYSTEM_SORT_MODE,
  filterFileSystemEntriesByHidden,
  sortFileSystemEntries
} from './filesystemSort'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const assertPathOrder = (
  actual: FileSystemEntry[],
  expectedPaths: string[],
  message: string
): void => {
  const actualPaths = actual.map((entry) => entry.path)
  assertEqual(JSON.stringify(actualPaths), JSON.stringify(expectedPaths), message)
}

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

const buildEntry = (overrides: Partial<FileSystemEntry> & Pick<FileSystemEntry, 'name' | 'path'>): FileSystemEntry => ({
  name: overrides.name,
  path: overrides.path,
  isDirectory: overrides.isDirectory === true,
  isSymbolicLink: overrides.isSymbolicLink === true,
  size: Number.isFinite(overrides.size) ? Number(overrides.size) : 0,
  ...(overrides.mode ? { mode: overrides.mode } : {}),
  ...(overrides.modifiedAt ? { modifiedAt: overrides.modifiedAt } : {}),
})

const FIXTURES: FileSystemEntry[] = [
  buildEntry({
    name: 'docs',
    path: '/docs',
    isDirectory: true,
    modifiedAt: '2026-03-20T10:00:00.000Z'
  }),
  buildEntry({
    name: 'archive',
    path: '/archive',
    isDirectory: true,
    modifiedAt: '2026-03-19T08:00:00.000Z'
  }),
  buildEntry({
    name: 'zeta.txt',
    path: '/zeta.txt',
    size: 10,
    modifiedAt: '2026-03-19T09:00:00.000Z'
  }),
  buildEntry({
    name: 'alpha.log',
    path: '/alpha.log',
    size: 400,
    modifiedAt: '2026-03-21T06:00:00.000Z'
  }),
  buildEntry({
    name: 'beta',
    path: '/beta',
    size: 40
  }),
  buildEntry({
    name: 'gamma.txt',
    path: '/gamma.txt',
    size: 120,
    modifiedAt: '2026-03-18T06:00:00.000Z'
  }),
]

runCase('default sorting uses latest modified timestamp first', () => {
  assertEqual(DEFAULT_FILESYSTEM_SORT_MODE, 'modified-desc', 'default sort mode should be latest modified first')
  assertPathOrder(
    sortFileSystemEntries(FIXTURES),
    ['/alpha.log', '/docs', '/zeta.txt', '/archive', '/gamma.txt', '/beta'],
    'default sorting should match modified newest ordering'
  )
})

runCase('name sorting mixes directories with files alphabetically', () => {
  assertPathOrder(
    sortFileSystemEntries(FIXTURES, 'name-asc'),
    ['/alpha.log', '/archive', '/beta', '/docs', '/gamma.txt', '/zeta.txt'],
    'name ascending should sort directories and files together alphabetically'
  )
  assertPathOrder(
    sortFileSystemEntries(FIXTURES, 'name-desc'),
    ['/zeta.txt', '/gamma.txt', '/docs', '/beta', '/archive', '/alpha.log'],
    'name descending should reverse the mixed directory and file order'
  )
})

runCase('modified sorting prefers timestamps and leaves unknown timestamps last', () => {
  assertPathOrder(
    sortFileSystemEntries(FIXTURES, 'modified-desc'),
    ['/alpha.log', '/docs', '/zeta.txt', '/archive', '/gamma.txt', '/beta'],
    'modified newest should order known timestamps first and keep missing timestamps at the end'
  )
  assertPathOrder(
    sortFileSystemEntries(FIXTURES, 'modified-asc'),
    ['/gamma.txt', '/archive', '/zeta.txt', '/docs', '/alpha.log', '/beta'],
    'modified oldest should still leave missing timestamps at the end'
  )
})

runCase('size sorting mixes directories with files by size', () => {
  assertPathOrder(
    sortFileSystemEntries(FIXTURES, 'size-desc'),
    ['/alpha.log', '/gamma.txt', '/beta', '/zeta.txt', '/archive', '/docs'],
    'size descending should sort directories and files together by size'
  )
  assertPathOrder(
    sortFileSystemEntries(FIXTURES, 'size-asc'),
    ['/archive', '/docs', '/zeta.txt', '/beta', '/gamma.txt', '/alpha.log'],
    'size ascending should surface the smallest files first'
  )
})

runCase('type sorting groups files by extension with name fallback', () => {
  assertPathOrder(
    sortFileSystemEntries(FIXTURES, 'type-asc'),
    ['/archive', '/beta', '/docs', '/alpha.log', '/gamma.txt', '/zeta.txt'],
    'type ascending should group extension-less files before extension buckets'
  )
  assertPathOrder(
    sortFileSystemEntries(FIXTURES, 'type-desc'),
    ['/gamma.txt', '/zeta.txt', '/alpha.log', '/archive', '/beta', '/docs'],
    'type descending should reverse extension buckets without forcing directories first'
  )
})

runCase('hidden-file filtering removes dotfiles without touching regular entries', () => {
  const actual = filterFileSystemEntriesByHidden([
    buildEntry({ name: '.env', path: '/.env', size: 12 }),
    buildEntry({ name: '.config', path: '/.config', isDirectory: true }),
    buildEntry({ name: 'visible.txt', path: '/visible.txt', size: 4 })
  ], false)
  assertPathOrder(
    actual,
    ['/visible.txt'],
    'hidden-file filtering should hide files and directories whose names start with a dot'
  )
  assertPathOrder(
    filterFileSystemEntriesByHidden(actual, true),
    ['/visible.txt'],
    'showing hidden files should keep already-visible entries intact'
  )
})
