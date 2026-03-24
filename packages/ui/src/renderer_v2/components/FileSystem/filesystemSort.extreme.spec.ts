import type { FileSystemEntry } from '../../lib/ipcTypes'
import { filterFileSystemEntriesByHidden, sortFileSystemEntries } from './filesystemSort'

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

runCase('name sorting keeps directories first and orders alphabetically', () => {
  assertPathOrder(
    sortFileSystemEntries(FIXTURES, 'name-asc'),
    ['/archive', '/docs', '/alpha.log', '/beta', '/gamma.txt', '/zeta.txt'],
    'name ascending should keep directories first and sort entries alphabetically'
  )
  assertPathOrder(
    sortFileSystemEntries(FIXTURES, 'name-desc'),
    ['/docs', '/archive', '/zeta.txt', '/gamma.txt', '/beta', '/alpha.log'],
    'name descending should reverse order within directory and file groups'
  )
})

runCase('modified sorting prefers timestamps and leaves unknown timestamps last', () => {
  assertPathOrder(
    sortFileSystemEntries(FIXTURES, 'modified-desc'),
    ['/docs', '/archive', '/alpha.log', '/zeta.txt', '/gamma.txt', '/beta'],
    'modified newest should order known timestamps first and keep missing timestamps at the end'
  )
  assertPathOrder(
    sortFileSystemEntries(FIXTURES, 'modified-asc'),
    ['/archive', '/docs', '/gamma.txt', '/zeta.txt', '/alpha.log', '/beta'],
    'modified oldest should still leave missing timestamps at the end'
  )
})

runCase('size sorting orders larger files first while preserving directory grouping', () => {
  assertPathOrder(
    sortFileSystemEntries(FIXTURES, 'size-desc'),
    ['/archive', '/docs', '/alpha.log', '/gamma.txt', '/beta', '/zeta.txt'],
    'size descending should sort by size inside each directory/file group'
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
    ['/archive', '/docs', '/beta', '/alpha.log', '/gamma.txt', '/zeta.txt'],
    'type ascending should group extension-less files before extension buckets'
  )
  assertPathOrder(
    sortFileSystemEntries(FIXTURES, 'type-desc'),
    ['/archive', '/docs', '/gamma.txt', '/zeta.txt', '/alpha.log', '/beta'],
    'type descending should reverse extension buckets while keeping directories grouped first'
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
