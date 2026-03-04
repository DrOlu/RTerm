import {
  FILESYSTEM_PANEL_DRAG_MIME,
  decodeTerminalScopedFilePath,
  extractNativeDropFilePaths,
  encodeFileSystemPanelDragPayload,
  encodeTerminalScopedFilePath,
  extractFileSystemPayloadPaths,
  hasFileSystemPanelDragPayloadType,
  hasNativeFileDragType,
  getFileMentionDisplayName,
  parseFileSystemPanelDragPayload,
  resolveTerminalDropPaths,
  resolveTerminalDropPathsForTarget
} from './filesystemDragDrop'

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const run = async (): Promise<void> => {
  await runCase('terminal scoped file paths round-trip with URI-safe terminal IDs', () => {
    const encoded = encodeTerminalScopedFilePath('local/main tab', '/tmp/demo.txt')
    const decoded = decodeTerminalScopedFilePath(encoded)
    assertCondition(!!decoded, 'decode should parse encoded scoped path')
    assertEqual(decoded?.terminalId || '', 'local/main tab', 'decoded terminal id should match source')
    assertEqual(decoded?.filePath || '', '/tmp/demo.txt', 'decoded file path should match source')
  })

  await runCase('file mention display name resolves scoped file path basename', () => {
    const scoped = encodeTerminalScopedFilePath('ssh-main', '/home/demo/readme.md')
    assertEqual(getFileMentionDisplayName(scoped), 'readme.md', 'scoped file path should render basename only')
  })

  await runCase('filesystem panel drag payload encode/decode round-trip', () => {
    const payload = {
      version: 1 as const,
      sourceTerminalId: 'ssh-1',
      sourceBasePath: '/home/demo',
      entries: [
        {
          name: 'a.txt',
          path: '/home/demo/a.txt',
          isDirectory: false,
          size: 4
        },
        {
          name: 'docs',
          path: '/home/demo/docs',
          isDirectory: true
        }
      ]
    }
    const encoded = encodeFileSystemPanelDragPayload(payload)
    const parsed = parseFileSystemPanelDragPayload({
      types: [FILESYSTEM_PANEL_DRAG_MIME],
      getData: (type: string) => (type === FILESYSTEM_PANEL_DRAG_MIME ? encoded : '')
    } as unknown as Pick<DataTransfer, 'types' | 'getData'>)

    assertCondition(!!parsed, 'payload should parse successfully')
    assertEqual(parsed?.sourceTerminalId || '', 'ssh-1', 'source terminal id should be preserved')
    assertEqual(parsed?.entries.length || 0, 2, 'entry count should be preserved')
    assertEqual(parsed?.entries[0].name || '', 'a.txt', 'first entry name should be preserved')
  })

  await runCase('invalid drag payload should fail closed', () => {
    const parsed = parseFileSystemPanelDragPayload({
      types: [FILESYSTEM_PANEL_DRAG_MIME],
      getData: () => '{"version":2}'
    } as unknown as Pick<DataTransfer, 'types' | 'getData'>)
    assertEqual(parsed, null, 'unsupported payload version should be rejected')
  })

  await runCase('drag type detection works without reading payload body', () => {
    const customOnly = hasFileSystemPanelDragPayloadType({
      types: [FILESYSTEM_PANEL_DRAG_MIME]
    } as unknown as Pick<DataTransfer, 'types'>)
    assertEqual(customOnly, true, 'filesystem payload mime type should be detected via types only')

    const nativeOnly = hasNativeFileDragType({
      types: ['Files']
    } as unknown as Pick<DataTransfer, 'types'>)
    assertEqual(nativeOnly, true, 'native file drag should be detected via Files type')

    const none = hasNativeFileDragType({
      types: ['text/plain']
    } as unknown as Pick<DataTransfer, 'types'>)
    assertEqual(none, false, 'non-file drags should be ignored')
  })

  await runCase('resolveTerminalDropPaths prioritizes filesystem payload and does not need native files', () => {
    const payload = {
      version: 1 as const,
      sourceTerminalId: 'local-1',
      sourceBasePath: '/tmp',
      entries: [
        { name: 'alpha.txt', path: '/tmp/alpha.txt', isDirectory: false },
        { name: 'alpha.txt duplicate', path: '/tmp/alpha.txt', isDirectory: false }
      ]
    }
    const encoded = encodeFileSystemPanelDragPayload(payload)
    const dataTransfer = {
      types: [FILESYSTEM_PANEL_DRAG_MIME, 'Files'],
      getData: (type: string) => (type === FILESYSTEM_PANEL_DRAG_MIME ? encoded : ''),
      get files(): never {
        throw new Error('native files should not be read when payload is present')
      }
    }
    const paths = resolveTerminalDropPaths(
      dataTransfer as unknown as Pick<DataTransfer, 'types' | 'getData' | 'files'>
    )
    assertEqual(paths.length, 1, 'paths should be deduplicated')
    assertEqual(paths[0], '/tmp/alpha.txt', 'payload path should be used')
  })

  await runCase('resolveTerminalDropPaths falls back to native file paths when payload is absent', () => {
    const nativeFileList = [
      { path: '/tmp/beta.txt' },
      { path: ' /tmp/beta.txt ' },
      { path: '/tmp/gamma.txt' }
    ] as unknown as FileList
    const dataTransfer = {
      types: ['Files'],
      getData: () => '',
      files: nativeFileList
    }
    const paths = resolveTerminalDropPaths(
      dataTransfer as unknown as Pick<DataTransfer, 'types' | 'getData' | 'files'>
    )
    assertEqual(paths.length, 2, 'native paths should be deduplicated')
    assertEqual(paths[0], '/tmp/beta.txt', 'first native path should be preserved')
    assertEqual(paths[1], '/tmp/gamma.txt', 'second native path should be preserved')
  })

  await runCase('resolveTerminalDropPathsForTarget blocks cross-terminal payload drops', () => {
    const payload = {
      version: 1 as const,
      sourceTerminalId: 'ssh-main',
      sourceBasePath: '/home/demo',
      entries: [{ name: 'notes.md', path: '/home/demo/notes.md', isDirectory: false }]
    }
    const encoded = encodeFileSystemPanelDragPayload(payload)
    const dataTransfer = {
      types: [FILESYSTEM_PANEL_DRAG_MIME],
      getData: (type: string) => (type === FILESYSTEM_PANEL_DRAG_MIME ? encoded : ''),
      files: [] as unknown as FileList
    }
    const blocked = resolveTerminalDropPathsForTarget(
      dataTransfer as unknown as Pick<DataTransfer, 'types' | 'getData' | 'files'>,
      'local-main'
    )
    assertEqual(blocked.length, 0, 'cross-terminal payload should be rejected')

    const allowed = resolveTerminalDropPathsForTarget(
      dataTransfer as unknown as Pick<DataTransfer, 'types' | 'getData' | 'files'>,
      'ssh-main'
    )
    assertEqual(allowed.length, 1, 'matching terminal payload should be accepted')
    assertEqual(allowed[0], '/home/demo/notes.md', 'accepted payload path should match source')
  })

  await runCase('standalone path extractors stay consistent', () => {
    const payload = {
      version: 1 as const,
      sourceTerminalId: 'ssh-1',
      sourceBasePath: '/home/demo',
      entries: [{ name: 'report.md', path: '/home/demo/report.md', isDirectory: false }]
    }
    const encoded = encodeFileSystemPanelDragPayload(payload)
    const payloadPaths = extractFileSystemPayloadPaths({
      types: [FILESYSTEM_PANEL_DRAG_MIME],
      getData: (type: string) => (type === FILESYSTEM_PANEL_DRAG_MIME ? encoded : '')
    } as unknown as Pick<DataTransfer, 'types' | 'getData'>)
    assertEqual(payloadPaths.length, 1, 'payload extractor should return one path')
    assertEqual(payloadPaths[0], '/home/demo/report.md', 'payload extractor path should match')

    const nativePaths = extractNativeDropFilePaths({
      files: [{ path: '/tmp/native.txt' }] as unknown as FileList
    } as unknown as Pick<DataTransfer, 'files'>)
    assertEqual(nativePaths.length, 1, 'native extractor should return one path')
    assertEqual(nativePaths[0], '/tmp/native.txt', 'native extractor path should match')
  })
}

void run()
  .then(() => {
    console.log('All filesystemDragDrop extreme tests passed.')
  })
  .catch((error) => {
    console.error(error)
    throw error
  })
