import { FileEditorStore } from './FileEditorStore'

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

const makeAppStoreMock = () => ({
  layout: {
    ensurePrimaryPanelForKind: () => 'panel-file-editor',
    focusPrimaryPanel: () => {}
  },
  i18n: {
    t: {
      fileEditor: {
        openPanelFailed: 'open-failed',
        unsavedChangesConfirm: 'unsaved-confirm',
        previewErrorFallback: 'preview-fallback',
        fileSaved: 'saved',
        saveErrorFallback: 'save-failed'
      }
    }
  }
} as any)

const run = async (): Promise<void> => {
  await runCase('openFromFileSystem loads text file and reuses existing panel', async () => {
    let readCallCount = 0
    let writeCallCount = 0
    ;(globalThis as unknown as { window: unknown }).window = {
      gyshell: {
        filesystem: {
          readTextFile: async (_terminalId: string, filePath: string) => {
            readCallCount += 1
            return {
              path: filePath,
              content: `content-${readCallCount}`,
              size: 10,
              encoding: 'utf8'
            }
          },
          writeTextFile: async () => {
            writeCallCount += 1
          }
        }
      },
      confirm: () => true
    }

    const store = new FileEditorStore(makeAppStoreMock())
    const opened = await store.openFromFileSystem('term-a', '/tmp/a.txt')
    assertEqual(opened, true, 'openFromFileSystem should open target file')
    assertEqual(readCallCount, 1, 'first open should call read API once')
    assertEqual(store.mode, 'text', 'file should enter text mode')
    assertEqual(store.content, 'content-1', 'loaded content should be persisted')

    const reopened = await store.openFromFileSystem('term-a', '/tmp/a.txt')
    assertEqual(reopened, true, 'reopening same file should still resolve true')
    assertEqual(readCallCount, 1, 'reopening same file should not trigger extra read')

    store.updateContent('updated-content')
    assertCondition(store.dirty, 'editing should mark file as dirty')
    const saved = await store.save()
    assertEqual(saved, true, 'save should succeed when editor is dirty')
    assertEqual(writeCallCount, 1, 'save should call write API exactly once')
    assertEqual(store.dirty, false, 'save should clear dirty state')
  })

  await runCase('clear resets editor state', () => {
    const store = new FileEditorStore(makeAppStoreMock())
    store.terminalId = 'term-a'
    store.filePath = '/tmp/a.txt'
    store.mode = 'text'
    store.content = 'x'
    store.dirty = true
    store.errorMessage = 'err'
    store.statusMessage = 'msg'

    store.clear()

    assertEqual(store.mode, 'idle', 'clear should reset mode')
    assertEqual(store.terminalId, null, 'clear should reset terminal id')
    assertEqual(store.filePath, null, 'clear should reset file path')
    assertEqual(store.content, '', 'clear should clear content')
    assertEqual(store.dirty, false, 'clear should reset dirty state')
    assertEqual(store.errorMessage, null, 'clear should reset error state')
    assertEqual(store.statusMessage, null, 'clear should reset status message')
  })

  await runCase('captureSnapshot and restoreSnapshot preserve editable document state', () => {
    const source = new FileEditorStore(makeAppStoreMock())
    source.terminalId = 'term-a'
    source.filePath = '/tmp/a.txt'
    source.mode = 'text'
    source.content = 'draft-content'
    source.dirty = true
    source.errorMessage = null
    source.statusMessage = 'saved-recently'

    const snapshot = source.captureSnapshot()

    const target = new FileEditorStore(makeAppStoreMock())
    const restored = target.restoreSnapshot(snapshot)
    assertEqual(restored, true, 'restoreSnapshot should accept a valid snapshot')
    assertEqual(target.terminalId, 'term-a', 'terminalId should be restored')
    assertEqual(target.filePath, '/tmp/a.txt', 'filePath should be restored')
    assertEqual(target.mode, 'text', 'mode should be restored')
    assertEqual(target.content, 'draft-content', 'content should be restored')
    assertEqual(target.dirty, true, 'dirty state should be restored')
    assertEqual(target.statusMessage, 'saved-recently', 'status message should be restored')
    assertEqual(target.busy, false, 'restoring snapshot should not keep busy state')
  })

  // --- Load-cancellation race ---
  await runCase('openFromFileSystem load-cancellation: second open supersedes first, first returns false', async () => {
    let firstReadResolve: ((value: unknown) => void) | null = null
    let callCount = 0
    ;(globalThis as unknown as { window: unknown }).window = {
      gyshell: {
        filesystem: {
          readTextFile: async (_terminalId: string, filePath: string) => {
            callCount += 1
            if (callCount === 1) {
              // Block until the test manually resolves this promise, simulating a slow network read.
              await new Promise<void>((resolve) => { firstReadResolve = resolve as unknown as (v: unknown) => void })
            }
            return { path: filePath, content: `content-${callCount}`, size: 10, encoding: 'utf8' as const }
          },
          writeTextFile: async () => {}
        }
      },
      confirm: () => true
    }

    const store = new FileEditorStore(makeAppStoreMock())

    // Fire first open — will block on the deferred readTextFile.
    const firstPromise = store.openFromFileSystem('term-a', '/tmp/a.txt')

    // Fire second open immediately (different file) — resolves right away.
    const secondResult = await store.openFromFileSystem('term-a', '/tmp/b.txt')

    assertEqual(secondResult, true, 'second open should succeed')
    assertEqual(store.filePath, '/tmp/b.txt', 'store should reflect the second open')
    assertEqual(store.content, 'content-2', 'store should have the second open content')
    assertEqual(store.mode, 'text', 'mode should be text after second open')

    // Now unblock the first open — it should detect it was superseded and return false.
    firstReadResolve!(null)
    const firstResult = await firstPromise

    assertEqual(firstResult, false, 'first open should return false after being superseded')
    assertEqual(store.filePath, '/tmp/b.txt', 'state should still reflect the second open')
    assertEqual(store.content, 'content-2', 'content should not be overwritten by the stale first open')
  })

  // --- openFromFileSystem error path ---
  await runCase('openFromFileSystem sets mode to error when readTextFile throws', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      gyshell: {
        filesystem: {
          readTextFile: async () => {
            throw new Error('Permission denied')
          },
          writeTextFile: async () => {}
        }
      },
      confirm: () => true
    }

    const store = new FileEditorStore(makeAppStoreMock())
    const result = await store.openFromFileSystem('term-a', '/tmp/secret.txt')

    assertEqual(result, false, 'openFromFileSystem should return false on read error')
    assertEqual(store.mode, 'error', 'mode should be set to error')
    assertCondition(store.errorMessage !== null && store.errorMessage.length > 0, 'errorMessage should be set')
    assertEqual(store.busy, false, 'busy should be cleared after error')
    assertEqual(store.dirty, false, 'dirty should not be set after a failed load')
  })

  // --- save() failure ---
  await runCase('save() returns false and preserves dirty state when writeTextFile throws', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      gyshell: {
        filesystem: {
          readTextFile: async (_terminalId: string, filePath: string) => ({
            path: filePath,
            content: 'original',
            size: 8,
            encoding: 'utf8' as const
          }),
          writeTextFile: async () => {
            throw new Error('Disk full')
          }
        }
      },
      confirm: () => true
    }

    const store = new FileEditorStore(makeAppStoreMock())
    await store.openFromFileSystem('term-a', '/tmp/a.txt')
    store.updateContent('modified content')
    assertEqual(store.dirty, true, 'editing should mark file as dirty')

    const saved = await store.save()

    assertEqual(saved, false, 'save should return false on write error')
    assertEqual(store.busy, false, 'busy should be cleared after save failure')
    assertCondition(store.errorMessage !== null, 'errorMessage should be set after save failure')
    // The dirty flag must NOT be cleared on failure — the user still has unsaved changes.
    assertEqual(store.dirty, true, 'dirty flag should remain set after a failed save')
    assertEqual(store.mode, 'text', 'mode should remain text after a failed save')
  })

  // --- Dirty-state confirmation guard ---
  await runCase('openFromFileSystem aborts without state change when user denies unsaved-changes dialog', async () => {
    let readCallCount = 0
    ;(globalThis as unknown as { window: unknown }).window = {
      gyshell: {
        filesystem: {
          readTextFile: async (_terminalId: string, filePath: string) => {
            readCallCount += 1
            return { path: filePath, content: `content-${readCallCount}`, size: 10, encoding: 'utf8' as const }
          },
          writeTextFile: async () => {}
        }
      },
      // User clicks "Cancel" on the native confirm dialog.
      confirm: () => false
    }

    const store = new FileEditorStore(makeAppStoreMock())
    await store.openFromFileSystem('term-a', '/tmp/a.txt')
    store.updateContent('dirty edit')
    assertEqual(store.dirty, true, 'editing should mark file as dirty')

    const result = await store.openFromFileSystem('term-a', '/tmp/b.txt')

    assertEqual(result, false, 'should return false when user cancels the unsaved-changes dialog')
    assertEqual(store.filePath, '/tmp/a.txt', 'filePath must not change when the user cancels')
    assertEqual(store.content, 'dirty edit', 'content must not change when the user cancels')
    assertEqual(store.dirty, true, 'dirty flag must remain set when the user cancels')
    assertEqual(readCallCount, 1, 'readTextFile must not be called again when the user cancels')
  })
}

void run()
  .then(() => {
    console.log('All FileEditorStore extreme tests passed.')
  })
  .catch((error) => {
    console.error(error)
    throw error
  })
