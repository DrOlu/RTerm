import { action, computed, makeObservable, observable, runInAction } from 'mobx'
import type { AppStore } from './AppStore'

export type FileEditorMode = 'idle' | 'loading' | 'text' | 'error'

export class FileEditorStore {
  terminalId: string | null = null
  filePath: string | null = null
  mode: FileEditorMode = 'idle'
  content = ''
  dirty = false
  busy = false
  errorMessage: string | null = null
  statusMessage: string | null = null

  private loadRequestVersion = 0

  constructor(private readonly appStore: AppStore) {
    makeObservable(this, {
      terminalId: observable,
      filePath: observable,
      mode: observable,
      content: observable,
      dirty: observable,
      busy: observable,
      errorMessage: observable,
      statusMessage: observable,
      hasActiveDocument: computed,
      canSave: computed,
      openFromFileSystem: action,
      updateContent: action,
      save: action,
      clear: action
    })
  }

  get hasActiveDocument(): boolean {
    return typeof this.terminalId === 'string' && this.terminalId.length > 0 && typeof this.filePath === 'string' && this.filePath.length > 0
  }

  get canSave(): boolean {
    return this.mode === 'text' && this.dirty && !this.busy && this.hasActiveDocument
  }

  async openFromFileSystem(terminalId: string, filePath: string): Promise<boolean> {
    const panelId = this.appStore.layout.ensurePrimaryPanelForKind('fileEditor')
    if (!panelId) {
      throw new Error(this.appStore.i18n.t.fileEditor.openPanelFailed)
    }
    this.appStore.layout.focusPrimaryPanel('fileEditor')

    const sameTarget = this.terminalId === terminalId && this.filePath === filePath
    if (sameTarget && (this.mode === 'text' || this.mode === 'loading')) {
      return true
    }

    if (!sameTarget && this.mode === 'text' && this.dirty) {
      const confirmed = window.confirm(this.appStore.i18n.t.fileEditor.unsavedChangesConfirm)
      if (!confirmed) {
        return false
      }
    }

    const requestVersion = this.loadRequestVersion + 1
    this.loadRequestVersion = requestVersion

    this.terminalId = terminalId
    this.filePath = filePath
    this.mode = 'loading'
    this.content = ''
    this.dirty = false
    this.busy = false
    this.errorMessage = null
    this.statusMessage = null

    try {
      const result = await window.gyshell.filesystem.readTextFile(terminalId, filePath, { maxBytes: 1024 * 1024 })
      if (this.loadRequestVersion !== requestVersion) {
        return false
      }
      runInAction(() => {
        this.terminalId = terminalId
        this.filePath = result.path
        this.mode = 'text'
        this.content = result.content
        this.dirty = false
        this.busy = false
        this.errorMessage = null
        this.statusMessage = null
      })
      return true
    } catch (error) {
      if (this.loadRequestVersion !== requestVersion) {
        return false
      }
      const message =
        error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0
          ? error.message
          : this.appStore.i18n.t.fileEditor.previewErrorFallback
      runInAction(() => {
        this.mode = 'error'
        this.errorMessage = message
        this.content = ''
        this.dirty = false
        this.busy = false
      })
      return false
    }
  }

  updateContent(nextContent: string): void {
    if (this.mode !== 'text') {
      return
    }
    this.content = nextContent
    this.dirty = true
  }

  async save(): Promise<boolean> {
    if (!this.canSave || !this.terminalId || !this.filePath) {
      return false
    }

    this.busy = true
    this.errorMessage = null
    this.statusMessage = null
    try {
      await window.gyshell.filesystem.writeTextFile(this.terminalId, this.filePath, this.content)
      runInAction(() => {
        this.dirty = false
        this.busy = false
        this.statusMessage = this.appStore.i18n.t.fileEditor.fileSaved
      })
      return true
    } catch (error) {
      const message =
        error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0
          ? error.message
          : this.appStore.i18n.t.fileEditor.saveErrorFallback
      runInAction(() => {
        this.busy = false
        this.errorMessage = message
      })
      return false
    }
  }

  clear(): void {
    this.loadRequestVersion += 1
    this.terminalId = null
    this.filePath = null
    this.mode = 'idle'
    this.content = ''
    this.dirty = false
    this.busy = false
    this.errorMessage = null
    this.statusMessage = null
  }
}

