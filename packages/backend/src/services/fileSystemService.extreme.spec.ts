import type { TerminalService } from './TerminalService'
import { FileSystemService } from './FileSystemService'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const assertRejects = async (
  fn: () => Promise<unknown>,
  messagePattern: RegExp,
  context: string
): Promise<void> => {
  try {
    await fn()
    throw new Error(`${context}: expected rejection`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!messagePattern.test(message)) {
      throw new Error(`${context}: unexpected error message "${message}"`)
    }
  }
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const createSamePathTransferService = () => {
  const calls = {
    deletePath: 0
  }
  const terminalService = {
    statFile: async (_terminalId: string, filePath: string) => {
      if (filePath === '/tmp') {
        return { exists: true, isDirectory: true }
      }
      if (filePath === '/tmp/a.txt') {
        return { exists: true, isDirectory: false }
      }
      return { exists: false, isDirectory: false }
    },
    readFileChunk: async () => ({
      chunk: Buffer.from('x'),
      bytesRead: 1,
      totalSize: 1,
      nextOffset: 1,
      eof: true
    }),
    getRemoteOs: () => 'unix' as const,
    getTerminalType: () => 'local' as const,
    getFileSystemIdentity: () => 'local://default',
    resolvePathForFileSystem: async (_terminalId: string, filePath: string) => filePath,
    deletePath: async () => {
      calls.deletePath += 1
    }
  }
  return {
    calls,
    service: new FileSystemService(terminalService as unknown as TerminalService)
  }
}

const run = async (): Promise<void> => {
  await runCase('transferEntries rejects identical paths across terminal ids on same filesystem', async () => {
    const { calls, service } = createSamePathTransferService()
    await assertRejects(
      async () => {
        await service.transferEntries('local-a', ['/tmp/a.txt'], 'local-b', '/tmp', {
          mode: 'copy',
          overwrite: true
        })
      },
      /Source and target are identical/,
      'same-path copy guard'
    )
    assertEqual(calls.deletePath, 0, 'same-path guard must prevent overwrite delete on source path')
  })

  await runCase('transferEntries treats identical move path as no-op across terminal ids on same filesystem', async () => {
    const { calls, service } = createSamePathTransferService()
    const result = await service.transferEntries('local-a', ['/tmp/a.txt'], 'local-b', '/tmp', {
      mode: 'move',
      overwrite: true
    })
    assertEqual(result.totalBytes, 0, 'same-path move should short-circuit with zero bytes')
    assertEqual(result.totalFiles, 0, 'same-path move should short-circuit with zero files')
    assertEqual(calls.deletePath, 0, 'same-path move short-circuit must not delete source path')
  })

  await runCase('transferEntries treats keep-both identical move path as no-op', async () => {
    const calls = {
      uploads: 0,
      deletePath: 0
    }
    const terminalService = {
      statFile: async (_terminalId: string, filePath: string) => {
        if (filePath === '/tmp') return { exists: true, isDirectory: true }
        if (filePath === '/tmp/a.txt') return { exists: true, isDirectory: false, size: 1 }
        return { exists: false, isDirectory: false }
      },
      getRemoteOs: () => 'unix' as const,
      getTerminalType: () => 'local' as const,
      getFileSystemIdentity: () => 'local://default',
      resolvePathForFileSystem: async (_terminalId: string, filePath: string) => filePath,
      uploadFileFromLocalPath: async () => {
        calls.uploads += 1
        return { totalBytes: 1 }
      },
      deletePath: async () => {
        calls.deletePath += 1
      }
    }
    const service = new FileSystemService(terminalService as unknown as TerminalService)

    const result = await service.transferEntries('local-a', ['/tmp/a.txt'], 'local-b', '/tmp', {
      mode: 'move',
      conflictStrategy: 'rename'
    })

    assertEqual(result.totalBytes, 0, 'keep-both same-path move should short-circuit with zero bytes')
    assertEqual(result.totalFiles, 0, 'keep-both same-path move should short-circuit with zero files')
    assertEqual(calls.uploads, 0, 'keep-both same-path move must not create a numbered copy')
    assertEqual(calls.deletePath, 0, 'keep-both same-path move must not delete the original file')
  })

  await runCase('transferEntries can keep both by renaming a same-folder copy', async () => {
    const calls = {
      uploads: [] as Array<{ sourcePath: string; targetPath: string }>,
      deletePath: 0
    }
    const existingPaths = new Set(['/dst/report.txt'])
    const terminalService = {
      statFile: async (_terminalId: string, filePath: string) => {
        if (filePath === '/dst') return { exists: true, isDirectory: true }
        if (filePath === '/dst/report.txt') return { exists: true, isDirectory: false, size: 7 }
        if (existingPaths.has(filePath)) return { exists: true, isDirectory: false, size: 7 }
        return { exists: false, isDirectory: false }
      },
      getRemoteOs: () => 'unix' as const,
      getTerminalType: () => 'local' as const,
      getFileSystemIdentity: () => 'local://x',
      resolvePathForFileSystem: async (_terminalId: string, filePath: string) => filePath,
      uploadFileFromLocalPath: async (_terminalId: string, sourcePath: string, targetPath: string) => {
        calls.uploads.push({ sourcePath, targetPath })
        return { totalBytes: 7 }
      },
      deletePath: async () => {
        calls.deletePath += 1
      }
    }
    const service = new FileSystemService(terminalService as unknown as TerminalService)

    const result = await service.transferEntries('local-a', ['/dst/report.txt'], 'local-a', '/dst', {
      mode: 'copy',
      conflictStrategy: 'rename'
    })

    assertEqual(result.transferredFiles, 1, 'renamed same-folder copy should transfer one file')
    assertEqual(calls.uploads.length, 1, 'renamed same-folder copy should upload once')
    assertEqual(calls.uploads[0].targetPath, '/dst/report (1).txt', 'conflicting copy should receive the first numbered suffix')
    assertEqual(calls.deletePath, 0, 'renamed copy must not delete the existing target')
  })

  await runCase('transferEntries increments numbered suffixes when keeping both', async () => {
    const calls = {
      targets: [] as string[]
    }
    const existingPaths = new Set([
      '/dst/report.txt',
      '/dst/report (1).txt',
      '/dst/report (2).txt'
    ])
    const terminalService = {
      statFile: async (_terminalId: string, filePath: string) => {
        if (filePath === '/dst') return { exists: true, isDirectory: true }
        if (filePath === '/src/report.txt') return { exists: true, isDirectory: false, size: 5 }
        if (existingPaths.has(filePath)) return { exists: true, isDirectory: false, size: 5 }
        return { exists: false, isDirectory: false }
      },
      getRemoteOs: () => 'unix' as const,
      getTerminalType: () => 'local' as const,
      getFileSystemIdentity: () => 'local://x',
      resolvePathForFileSystem: async (_terminalId: string, filePath: string) => filePath,
      uploadFileFromLocalPath: async (_terminalId: string, _sourcePath: string, targetPath: string) => {
        calls.targets.push(targetPath)
        return { totalBytes: 5 }
      },
      deletePath: async () => {}
    }
    const service = new FileSystemService(terminalService as unknown as TerminalService)

    await service.transferEntries('local-a', ['/src/report.txt'], 'local-a', '/dst', {
      mode: 'copy',
      conflictStrategy: 'rename'
    })

    assertEqual(calls.targets[0], '/dst/report (3).txt', 'renamed copy should skip existing numbered suffixes')
  })

  await runCase('transferEntries increments an incoming numbered filename when keeping both', async () => {
    const calls = {
      targets: [] as string[]
    }
    const existingPaths = new Set(['/dst/report (2).txt'])
    const terminalService = {
      statFile: async (_terminalId: string, filePath: string) => {
        if (filePath === '/dst') return { exists: true, isDirectory: true }
        if (filePath === '/src/report (2).txt') return { exists: true, isDirectory: false, size: 5 }
        if (existingPaths.has(filePath)) return { exists: true, isDirectory: false, size: 5 }
        return { exists: false, isDirectory: false }
      },
      getRemoteOs: () => 'unix' as const,
      getTerminalType: () => 'local' as const,
      getFileSystemIdentity: () => 'local://x',
      resolvePathForFileSystem: async (_terminalId: string, filePath: string) => filePath,
      uploadFileFromLocalPath: async (_terminalId: string, _sourcePath: string, targetPath: string) => {
        calls.targets.push(targetPath)
        return { totalBytes: 5 }
      },
      deletePath: async () => {}
    }
    const service = new FileSystemService(terminalService as unknown as TerminalService)

    await service.transferEntries('local-a', ['/src/report (2).txt'], 'local-a', '/dst', {
      mode: 'copy',
      conflictStrategy: 'rename'
    })

    assertEqual(calls.targets[0], '/dst/report (3).txt', 'incoming numeric suffix should continue from its current number')
  })

  await runCase('transferEntries resets unsafe numeric suffixes when keeping both', async () => {
    const calls = {
      targets: [] as string[]
    }
    const unsafeSuffix = '99999999999999999999'
    const sourcePath = `/src/report (${unsafeSuffix}).txt`
    const existingPaths = new Set([`/dst/report (${unsafeSuffix}).txt`])
    const terminalService = {
      statFile: async (_terminalId: string, filePath: string) => {
        if (filePath === '/dst') return { exists: true, isDirectory: true }
        if (filePath === sourcePath) return { exists: true, isDirectory: false, size: 5 }
        if (existingPaths.has(filePath)) return { exists: true, isDirectory: false, size: 5 }
        return { exists: false, isDirectory: false }
      },
      getRemoteOs: () => 'unix' as const,
      getTerminalType: () => 'local' as const,
      getFileSystemIdentity: () => 'local://x',
      resolvePathForFileSystem: async (_terminalId: string, filePath: string) => filePath,
      uploadFileFromLocalPath: async (_terminalId: string, _sourcePath: string, targetPath: string) => {
        calls.targets.push(targetPath)
        return { totalBytes: 5 }
      },
      deletePath: async () => {}
    }
    const service = new FileSystemService(terminalService as unknown as TerminalService)

    await service.transferEntries('local-a', [sourcePath], 'local-a', '/dst', {
      mode: 'copy',
      conflictStrategy: 'rename'
    })

    assertEqual(calls.targets[0], '/dst/report (1).txt', 'unsafe numeric suffix should restart at the first safe suffix')
  })

  await runCase('transferEntries renames duplicate target names within one keep-both batch', async () => {
    const calls = {
      targets: [] as string[]
    }
    const terminalService = {
      statFile: async (_terminalId: string, filePath: string) => {
        if (filePath === '/dst') return { exists: true, isDirectory: true }
        if (filePath === '/src-a/a.txt') return { exists: true, isDirectory: false, size: 3 }
        if (filePath === '/src-b/a.txt') return { exists: true, isDirectory: false, size: 4 }
        return { exists: false, isDirectory: false }
      },
      getRemoteOs: () => 'unix' as const,
      getTerminalType: () => 'local' as const,
      getFileSystemIdentity: () => 'local://x',
      resolvePathForFileSystem: async (_terminalId: string, filePath: string) => filePath,
      uploadFileFromLocalPath: async (_terminalId: string, _sourcePath: string, targetPath: string) => {
        calls.targets.push(targetPath)
        return { totalBytes: 3 }
      },
      deletePath: async () => {}
    }
    const service = new FileSystemService(terminalService as unknown as TerminalService)

    await service.transferEntries('local-a', ['/src-a/a.txt', '/src-b/a.txt'], 'local-a', '/dst', {
      mode: 'copy',
      conflictStrategy: 'rename'
    })

    assertEqual(calls.targets[0], '/dst/a.txt', 'first batch item should use the original name when available')
    assertEqual(calls.targets[1], '/dst/a (1).txt', 'second batch item should be renamed to avoid batch target collision')
  })

  await runCase('readTextFile enforces maxBytes before full file read', async () => {
    const counters = {
      readFile: 0
    }
    const terminalService = {
      statFile: async () => ({ exists: true, isDirectory: false }),
      readFileChunk: async () => ({
        chunk: Buffer.from('x'),
        bytesRead: 1,
        totalSize: 4096,
        nextOffset: 1,
        eof: false
      }),
      readFile: async () => {
        counters.readFile += 1
        return Buffer.alloc(4096)
      }
    }
    const service = new FileSystemService(terminalService as unknown as TerminalService)
    await assertRejects(
      async () => {
        await service.readTextFile('terminal-a', '/tmp/huge.txt', { maxBytes: 1024 })
      },
      /File is too large for text read/,
      'readTextFile maxBytes pre-check'
    )
    assertEqual(counters.readFile, 0, 'readTextFile should not load whole file when probe already exceeds maxBytes')
  })

  await runCase('readFileBase64 enforces maxBytes before full file read', async () => {
    const counters = {
      readFile: 0
    }
    const terminalService = {
      statFile: async () => ({ exists: true, isDirectory: false }),
      readFileChunk: async () => ({
        chunk: Buffer.from('x'),
        bytesRead: 1,
        totalSize: 4096,
        nextOffset: 1,
        eof: false
      }),
      readFile: async () => {
        counters.readFile += 1
        return Buffer.alloc(4096)
      }
    }
    const service = new FileSystemService(terminalService as unknown as TerminalService)
    await assertRejects(
      async () => {
        await service.readFileBase64('terminal-a', '/tmp/huge.bin', { maxBytes: 1024 })
      },
      /File is too large to transfer/,
      'readFileBase64 maxBytes pre-check'
    )
    assertEqual(counters.readFile, 0, 'readFileBase64 should not load whole file when probe already exceeds maxBytes')
  })

  await runCase('readTextFile decodes UTF-16LE desktop.ini content as text', async () => {
    const desktopIniUtf16 = Buffer.from('\uFEFF[.ShellClassInfo]\r\nLocalizedResourceName=@%SystemRoot%\\system32\\shell32.dll,-21787\r\n', 'utf16le')
    const terminalService = {
      statFile: async () => ({ exists: true, isDirectory: false, size: desktopIniUtf16.length }),
      readFile: async () => desktopIniUtf16
    }
    const service = new FileSystemService(terminalService as unknown as TerminalService)

    const result = await service.readTextFile('terminal-a', 'C:\\Users\\tester\\Desktop\\desktop.ini')
    if (!result.content.includes('[.ShellClassInfo]')) {
      throw new Error(`expected decoded desktop.ini content, got: ${JSON.stringify(result.content)}`)
    }
    if (!result.content.includes('LocalizedResourceName=')) {
      throw new Error(`expected LocalizedResourceName line, got: ${JSON.stringify(result.content)}`)
    }
  })

  await runCase('readTextFile still rejects binary payloads with null bytes', async () => {
    const binaryBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x00, 0x10])
    const terminalService = {
      statFile: async () => ({ exists: true, isDirectory: false, size: binaryBytes.length }),
      readFile: async () => binaryBytes
    }
    const service = new FileSystemService(terminalService as unknown as TerminalService)
    await assertRejects(
      async () => {
        await service.readTextFile('terminal-a', '/tmp/blob.bin')
      },
      /File appears to be binary/,
      'readTextFile binary guard remains active'
    )
  })

  // --- Move mode: source deleted after successful copy ---
  await runCase('transferEntries with mode=move deletes source paths after successful copy', async () => {
    const calls = {
      uploadCount: 0,
      deletedPaths: [] as string[]
    }
    const terminalService = {
      statFile: async (_terminalId: string, filePath: string) => {
        if (filePath === '/dst') return { exists: true, isDirectory: true }
        if (filePath === '/src/a.txt') return { exists: true, isDirectory: false, size: 10 }
        if (filePath === '/dst/a.txt') return { exists: false, isDirectory: false }
        return { exists: false, isDirectory: false }
      },
      getRemoteOs: () => 'unix' as const,
      getTerminalType: () => 'local' as const,
      getFileSystemIdentity: () => 'local://x',
      resolvePathForFileSystem: async (_terminalId: string, filePath: string) => filePath,
      uploadFileFromLocalPath: async () => {
        calls.uploadCount += 1
        return { totalBytes: 10 }
      },
      deletePath: async (_terminalId: string, targetPath: string) => {
        calls.deletedPaths.push(targetPath)
      }
    }
    const service = new FileSystemService(terminalService as unknown as TerminalService)

    const result = await service.transferEntries('local-a', ['/src/a.txt'], 'local-a', '/dst', {
      mode: 'move'
    })

    assertEqual(result.mode, 'move', 'result.mode should be move')
    assertEqual(result.transferredFiles, 1, 'should have transferred 1 file')
    assertEqual(calls.uploadCount, 1, 'uploadFileFromLocalPath should be called once for the copy phase')
    const sourceDeleted = calls.deletedPaths.includes('/src/a.txt')
    if (!sourceDeleted) throw new Error(`expected /src/a.txt in deletedPaths but got: ${JSON.stringify(calls.deletedPaths)}`)
  })

  // --- Rollback: created target entries are cleaned up on copy failure ---
  await runCase('transferEntries rollback removes created target entries when copy fails', async () => {
    const calls = {
      deletedPaths: [] as string[]
    }
    const terminalService = {
      statFile: async (_terminalId: string, filePath: string) => {
        if (filePath === '/dst') return { exists: true, isDirectory: true }
        if (filePath === '/src/a.txt') return { exists: true, isDirectory: false, size: 10 }
        if (filePath === '/dst/a.txt') return { exists: false, isDirectory: false }
        return { exists: false, isDirectory: false }
      },
      getRemoteOs: () => 'unix' as const,
      getTerminalType: () => 'local' as const,
      getFileSystemIdentity: () => 'local://x',
      resolvePathForFileSystem: async (_terminalId: string, filePath: string) => filePath,
      uploadFileFromLocalPath: async () => {
        throw new Error('Simulated copy failure')
      },
      deletePath: async (_terminalId: string, targetPath: string) => {
        calls.deletedPaths.push(targetPath)
      }
    }
    const service = new FileSystemService(terminalService as unknown as TerminalService)

    let threw = false
    try {
      await service.transferEntries('local-a', ['/src/a.txt'], 'local-a', '/dst', { mode: 'copy' })
    } catch {
      threw = true
    }

    if (!threw) throw new Error('transferEntries should throw on copy failure')
    // The target path was never-existed so it was added to createdTargetRoots.
    // On rollback it should be deleted even though the copy never wrote any bytes.
    const targetRolledBack = calls.deletedPaths.includes('/dst/a.txt')
    if (!targetRolledBack) {
      throw new Error(`expected /dst/a.txt in rollback deletedPaths but got: ${JSON.stringify(calls.deletedPaths)}`)
    }
  })

  // --- AbortSignal cancellation ---
  await runCase('transferEntries with a pre-aborted AbortSignal throws the cancellation error', async () => {
    const terminalService = {
      statFile: async (_terminalId: string, filePath: string) => {
        if (filePath === '/dst') return { exists: true, isDirectory: true }
        if (filePath === '/src/a.txt') return { exists: true, isDirectory: false, size: 10 }
        if (filePath === '/dst/a.txt') return { exists: false, isDirectory: false }
        return { exists: false, isDirectory: false }
      },
      getRemoteOs: () => 'unix' as const,
      getTerminalType: () => 'local' as const,
      // Different identities: not the same filesystem, so same-path guard doesn't apply.
      getFileSystemIdentity: (_terminalId: string) => `local://${_terminalId}`,
      resolvePathForFileSystem: async (_terminalId: string, filePath: string) => filePath,
      uploadFileFromLocalPath: async () => ({ totalBytes: 10 }),
      deletePath: async () => {}
    }
    const service = new FileSystemService(terminalService as unknown as TerminalService)

    const controller = new AbortController()
    controller.abort() // Pre-abort before the call

    await assertRejects(
      async () => {
        await service.transferEntries('local-a', ['/src/a.txt'], 'local-a', '/dst', {
          signal: controller.signal
        })
      },
      /Transfer cancelled/i,
      'pre-aborted signal should cause a cancellation error'
    )
  })

  // --- Different filesystem identities: same-path guard does not apply ---
  await runCase('transferEntries across different filesystem identities copies even when paths match', async () => {
    const calls = { uploadCount: 0 }
    const terminalService = {
      statFile: async (_terminalId: string, filePath: string) => {
        // Target dir exists on the remote
        if (_terminalId === 'remote-b' && filePath === '/tmp') return { exists: true, isDirectory: true }
        // Source file exists on local
        if (_terminalId === 'local-a' && filePath === '/tmp/a.txt') return { exists: true, isDirectory: false, size: 5 }
        // Target file does not yet exist on remote
        if (_terminalId === 'remote-b' && filePath === '/tmp/a.txt') return { exists: false, isDirectory: false }
        return { exists: false, isDirectory: false }
      },
      getRemoteOs: () => 'unix' as const,
      getTerminalType: (_terminalId: string) => (_terminalId === 'local-a' ? 'local' as const : 'ssh' as const),
      // Different filesystem identities → sameFileSystem = false
      getFileSystemIdentity: (_terminalId: string) => (_terminalId === 'local-a' ? 'local://machine' : 'ssh://server1'),
      resolvePathForFileSystem: async (_terminalId: string, filePath: string) => filePath,
      uploadFileFromLocalPath: async () => {
        calls.uploadCount += 1
        return { totalBytes: 5 }
      },
      deletePath: async () => {}
    }
    const service = new FileSystemService(terminalService as unknown as TerminalService)

    // Same path (/tmp/a.txt) on both sides but different filesystem identities.
    // This should succeed as a normal copy — the same-path guard must NOT fire.
    const result = await service.transferEntries('local-a', ['/tmp/a.txt'], 'remote-b', '/tmp', {
      mode: 'copy'
    })

    assertEqual(result.transferredFiles, 1, 'should have transferred 1 file across filesystems')
    assertEqual(calls.uploadCount, 1, 'uploadFileFromLocalPath should be called once')
  })

  // --- Windows-style path normalisation: case-insensitive same-path detection ---
  await runCase('transferEntries detects identical Windows paths case-insensitively on same filesystem', async () => {
    const terminalService = {
      statFile: async (_terminalId: string, filePath: string) => {
        // Normalise both slashes for comparison in the mock
        const normalized = filePath.replace(/\\/g, '/').toLowerCase()
        if (normalized === 'c:/users/foo') return { exists: true, isDirectory: true }
        if (normalized === 'c:/users/foo/file.txt') return { exists: true, isDirectory: false, size: 20 }
        return { exists: false, isDirectory: false }
      },
      getRemoteOs: () => 'windows' as const,
      getTerminalType: () => 'ssh' as const,
      getFileSystemIdentity: () => 'ssh://winserver',
      resolvePathForFileSystem: async (_terminalId: string, filePath: string) => filePath,
      deletePath: async () => {}
    }
    const service = new FileSystemService(terminalService as unknown as TerminalService)

    // Source uses upper-case drive + mixed-case path; target dir uses lower-case.
    // After normalisation both resolve to the same Windows path → "identical" error.
    await assertRejects(
      async () => {
        await service.transferEntries(
          'win-a', ['C:\\Users\\FOO\\file.txt'],
          'win-a', 'C:\\Users\\foo',
          { mode: 'copy' }
        )
      },
      /Source and target are identical/,
      'Windows paths should be compared case-insensitively on the same filesystem'
    )
  })
}

void run().catch((error) => {
  console.error(error)
  process.exit(1)
})
