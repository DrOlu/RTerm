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
    getPrimaryPanelId: () => 'panel-file-editor',
    ensurePrimaryPanelForKind: () => 'panel-file-editor',
    focusPrimaryPanel: () => {}
  },
  openDetachedFileEditorForPath: async () => false,
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
  await runCase('openFromFileSystem opens a detached editor window when no local editor panel exists', async () => {
    let readCallCount = 0
    const detachedRequests: Array<{ terminalId: string; filePath: string }> = []
    ;(globalThis as unknown as { window: unknown }).window = {
      gyshell: {
        filesystem: {
          readTextFile: async () => {
            readCallCount += 1
            return {
              path: '/tmp/unused.txt',
              content: 'unused',
              size: 6,
              encoding: 'utf8' as const
            }
          },
          writeTextFile: async () => {}
        }
      },
      confirm: () => true
    }

    const store = new FileEditorStore({
      ...makeAppStoreMock(),
      layout: {
        getPrimaryPanelId: () => null,
        ensurePrimaryPanelForKind: () => {
          throw new Error('ensurePrimaryPanelForKind should not run when detached editor open succeeds')
        },
        focusPrimaryPanel: () => {}
      },
      openDetachedFileEditorForPath: async (terminalId: string, filePath: string) => {
        detachedRequests.push({ terminalId, filePath })
        return true
      }
    } as any)

    const opened = await store.openFromFileSystem('term-a', '/tmp/detached.txt')
    assertEqual(opened, true, 'openFromFileSystem should resolve true when detached editor open succeeds')
    assertEqual(readCallCount, 0, 'current window should not read the file when detached editor takes ownership')
    assertEqual(detachedRequests.length, 1, 'detached editor helper should be called exactly once')
    assertEqual(detachedRequests[0].terminalId, 'term-a', 'detached helper should receive the terminal id')
    assertEqual(detachedRequests[0].filePath, '/tmp/detached.txt', 'detached helper should receive the file path')
    assertEqual(store.mode, 'idle', 'local file editor store should remain idle when file opens in a detached window')
  })

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

  await runCase('refresh reloads the current file content from disk', async () => {
    let readCallCount = 0
    ;(globalThis as unknown as { window: unknown }).window = {
      gyshell: {
        filesystem: {
          readTextFile: async (_terminalId: string, filePath: string) => {
            readCallCount += 1
            return {
              path: filePath,
              content: `content-${readCallCount}`,
              size: 10,
              encoding: 'utf8' as const
            }
          },
          writeTextFile: async () => {}
        }
      },
      confirm: () => true
    }

    const store = new FileEditorStore(makeAppStoreMock())
    await store.openFromFileSystem('term-a', '/tmp/a.txt')
    store.statusMessage = 'stale-status'

    const refreshed = await store.refresh()

    assertEqual(refreshed, true, 'refresh should succeed when an active document exists')
    assertEqual(readCallCount, 2, 'refresh should trigger a new readTextFile call')
    assertEqual(store.content, 'content-2', 'refresh should replace the current content with the latest disk content')
    assertEqual(store.dirty, false, 'refresh should leave the reloaded document clean')
    assertEqual(store.statusMessage, null, 'refresh should clear stale status messages')
  })

  await runCase('refresh aborts when user cancels the unsaved-changes dialog', async () => {
    let readCallCount = 0
    let confirmCallCount = 0
    ;(globalThis as unknown as { window: unknown }).window = {
      gyshell: {
        filesystem: {
          readTextFile: async (_terminalId: string, filePath: string) => {
            readCallCount += 1
            return {
              path: filePath,
              content: `content-${readCallCount}`,
              size: 10,
              encoding: 'utf8' as const
            }
          },
          writeTextFile: async () => {}
        }
      },
      confirm: () => {
        confirmCallCount += 1
        return false
      }
    }

    const store = new FileEditorStore(makeAppStoreMock())
    await store.openFromFileSystem('term-a', '/tmp/a.txt')
    store.updateContent('dirty-edit')

    const refreshed = await store.refresh()

    assertEqual(refreshed, false, 'refresh should return false when the user cancels')
    assertEqual(confirmCallCount, 1, 'refresh should prompt once before discarding dirty edits')
    assertEqual(readCallCount, 1, 'refresh must not read the file again when the user cancels')
    assertEqual(store.content, 'dirty-edit', 'refresh must preserve local dirty content when cancelled')
    assertEqual(store.dirty, true, 'refresh must preserve dirty state when cancelled')
  })

  await runCase('refresh replaces dirty content after user confirms discard', async () => {
    let readCallCount = 0
    let confirmCallCount = 0
    ;(globalThis as unknown as { window: unknown }).window = {
      gyshell: {
        filesystem: {
          readTextFile: async (_terminalId: string, filePath: string) => {
            readCallCount += 1
            return {
              path: filePath,
              content: `content-${readCallCount}`,
              size: 10,
              encoding: 'utf8' as const
            }
          },
          writeTextFile: async () => {}
        }
      },
      confirm: () => {
        confirmCallCount += 1
        return true
      }
    }

    const store = new FileEditorStore(makeAppStoreMock())
    await store.openFromFileSystem('term-a', '/tmp/a.txt')
    store.updateContent('dirty-edit')

    const refreshed = await store.refresh()

    assertEqual(refreshed, true, 'refresh should succeed when the user confirms discarding dirty edits')
    assertEqual(confirmCallCount, 1, 'refresh should prompt once before reloading dirty content')
    assertEqual(readCallCount, 2, 'refresh should reread the file after confirmation')
    assertEqual(store.content, 'content-2', 'refresh should replace dirty content with disk content after confirmation')
    assertEqual(store.dirty, false, 'refresh should clear dirty state after reloading')
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

  await runCase('restoreSnapshot resumes loading snapshots in the target store', async () => {
    let readCallCount = 0
    ;(globalThis as unknown as { window: unknown }).window = {
      gyshell: {
        filesystem: {
          readTextFile: async (_terminalId: string, filePath: string) => {
            readCallCount += 1
            return {
              path: filePath,
              content: 'restored-content',
              size: 16,
              encoding: 'utf8' as const
            }
          },
          writeTextFile: async () => {}
        }
      },
      confirm: () => true
    }

    const source = new FileEditorStore(makeAppStoreMock())
    source.terminalId = 'term-a'
    source.filePath = '/tmp/loading.txt'
    source.mode = 'loading'

    const snapshot = source.captureSnapshot()

    const target = new FileEditorStore(makeAppStoreMock())
    const restored = target.restoreSnapshot(snapshot)
    assertEqual(restored, true, 'restoreSnapshot should accept loading snapshots')
    assertEqual(target.mode, 'loading', 'target should enter loading mode immediately')

    await new Promise((resolve) => setTimeout(resolve, 0))

    assertEqual(readCallCount, 1, 'restoring a loading snapshot should restart the file read')
    assertEqual(target.mode, 'text', 'target should leave loading mode after the restarted read')
    assertEqual(target.content, 'restored-content', 'target should receive the reloaded content')
    assertEqual(target.filePath, '/tmp/loading.txt', 'target should keep the restored file path')
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

  await runCase('independent editor stores save different files without mixing state', async () => {
    const writeCalls: Array<{ terminalId: string; filePath: string; content: string }> = []
    ;(globalThis as unknown as { window: unknown }).window = {
      gyshell: {
        filesystem: {
          readTextFile: async (_terminalId: string, filePath: string) => ({
            path: filePath,
            content: `initial:${filePath}`,
            size: filePath.length + 8,
            encoding: 'utf8' as const
          }),
          writeTextFile: async (terminalId: string, filePath: string, content: string) => {
            writeCalls.push({ terminalId, filePath, content })
          }
        }
      },
      confirm: () => true
    }

    const storeA = new FileEditorStore(makeAppStoreMock())
    const storeB = new FileEditorStore(makeAppStoreMock())

    await storeA.openFromFileSystem('term-a', '/tmp/a.txt')
    await storeB.openFromFileSystem('term-b', '/tmp/b.txt')

    storeA.updateContent('alpha')
    storeB.updateContent('beta')

    const savedB = await storeB.save()
    assertEqual(savedB, true, 'second editor should save successfully')
    assertEqual(storeA.dirty, true, 'saving the second editor must not clear the first editor dirty state')
    assertEqual(storeA.content, 'alpha', 'saving the second editor must not overwrite the first editor content')

    const savedA = await storeA.save()
    assertEqual(savedA, true, 'first editor should save successfully after the second editor')
    assertEqual(storeA.dirty, false, 'first editor dirty state should clear after its own save')
    assertEqual(storeB.dirty, false, 'second editor dirty state should stay cleared after its save')
    assertEqual(
      JSON.stringify(writeCalls),
      JSON.stringify([
        { terminalId: 'term-b', filePath: '/tmp/b.txt', content: 'beta' },
        { terminalId: 'term-a', filePath: '/tmp/a.txt', content: 'alpha' }
      ]),
      'each editor should write only its own terminalId, filePath, and content'
    )
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
