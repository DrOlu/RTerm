import { action, computed, makeObservable, observable, runInAction } from 'mobx'
import type { AppStore } from './AppStore'
import { normalizeFileEditorSnapshot, type FileEditorSnapshot } from '../lib/fileEditorSnapshot'
import {
  MEDIA_PREVIEW_MAX_BYTES,
  resolveFilePreviewKindForPath,
  TEXT_PREVIEW_MAX_BYTES,
  type FilePreviewKind,
} from '../lib/filePreviewSupport'

export type FileEditorMode = 'idle' | 'loading' | 'text' | 'image' | 'pdf' | 'error'

export class FileEditorStore {
  terminalId: string | null = null
  filePath: string | null = null
  mode: FileEditorMode = 'idle'
  content = ''
  contentBase64 = ''
  mimeType = ''
  fileSize = 0
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
      contentBase64: observable,
      mimeType: observable,
      fileSize: observable,
      dirty: observable,
      busy: observable,
      errorMessage: observable,
      statusMessage: observable,
      hasActiveDocument: computed,
      canSave: computed,
      previewDataUrl: computed,
      openFromFileSystem: action,
      updateContent: action,
      refresh: action,
      save: action,
      captureSnapshot: action,
      restoreSnapshot: action,
      clear: action,
    })
  }

  get hasActiveDocument(): boolean {
    return (
      typeof this.terminalId === 'string' &&
      this.terminalId.length > 0 &&
      typeof this.filePath === 'string' &&
      this.filePath.length > 0
    )
  }

  get canSave(): boolean {
    return this.mode === 'text' && this.dirty && !this.busy && this.hasActiveDocument
  }

  get previewDataUrl(): string {
    if (!this.contentBase64 || !this.mimeType) {
      return ''
    }
    return `data:${this.mimeType};base64,${this.contentBase64}`
  }

  private clearLoadedContent(): void {
    this.content = ''
    this.contentBase64 = ''
    this.mimeType = ''
    this.fileSize = 0
  }

  private async loadTextFileForRequest(terminalId: string, filePath: string, requestVersion: number): Promise<boolean> {
    try {
      const result = await window.gyshell.filesystem.readTextFile(terminalId, filePath, {
        maxBytes: TEXT_PREVIEW_MAX_BYTES,
      })
      if (this.loadRequestVersion !== requestVersion) {
        return false
      }
      runInAction(() => {
        this.terminalId = terminalId
        this.filePath = result.path
        this.mode = 'text'
        this.content = result.content
        this.contentBase64 = ''
        this.mimeType = ''
        this.fileSize = result.size
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
        this.clearLoadedContent()
        this.dirty = false
        this.busy = false
      })
      return false
    }
  }

  private async loadMediaFileForRequest(
    terminalId: string,
    filePath: string,
    kind: Extract<FilePreviewKind, 'image' | 'pdf'>,
    requestVersion: number,
  ): Promise<boolean> {
    try {
      const result = await window.gyshell.filesystem.readFileBase64(terminalId, filePath, {
        maxBytes: MEDIA_PREVIEW_MAX_BYTES,
      })
      if (this.loadRequestVersion !== requestVersion) {
        return false
      }
      runInAction(() => {
        this.terminalId = terminalId
        this.filePath = result.path
        this.mode = kind
        this.content = ''
        this.contentBase64 = result.contentBase64
        this.mimeType = result.mimeType
        this.fileSize = result.size
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
        this.clearLoadedContent()
        this.dirty = false
        this.busy = false
      })
      return false
    }
  }

  private async loadFileForRequest(terminalId: string, filePath: string, requestVersion: number): Promise<boolean> {
    const previewKind = resolveFilePreviewKindForPath(filePath)
    if (previewKind === 'image' || previewKind === 'pdf') {
      return await this.loadMediaFileForRequest(terminalId, filePath, previewKind, requestVersion)
    }
    return await this.loadTextFileForRequest(terminalId, filePath, requestVersion)
  }

  async openFromFileSystem(terminalId: string, filePath: string): Promise<boolean> {
    const existingPanelId = this.appStore.layout.getPrimaryPanelId('fileEditor')
    if (!existingPanelId) {
      const detachedOpened = await this.appStore.openDetachedFileEditorForPath(terminalId, filePath)
      if (detachedOpened) {
        return true
      }
    }

    const panelId = this.appStore.layout.ensurePrimaryPanelForKind('fileEditor')
    if (!panelId) {
      throw new Error(this.appStore.i18n.t.fileEditor.openPanelFailed)
    }
    this.appStore.layout.focusPrimaryPanel('fileEditor')

    const sameTarget = this.terminalId === terminalId && this.filePath === filePath
    if (
      sameTarget &&
      (this.mode === 'text' || this.mode === 'image' || this.mode === 'pdf' || this.mode === 'loading')
    ) {
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
    this.clearLoadedContent()
    this.dirty = false
    this.busy = false
    this.errorMessage = null
    this.statusMessage = null

    return await this.loadFileForRequest(terminalId, filePath, requestVersion)
  }

  updateContent(nextContent: string): void {
    if (this.mode !== 'text') {
      return
    }
    this.content = nextContent
    this.dirty = true
  }

  async refresh(): Promise<boolean> {
    if (!this.hasActiveDocument || !this.terminalId || !this.filePath || this.busy || this.mode === 'loading') {
      return false
    }

    if (this.mode === 'text' && this.dirty) {
      const confirmed = window.confirm(this.appStore.i18n.t.fileEditor.unsavedChangesConfirm)
      if (!confirmed) {
        return false
      }
    }

    const terminalId = this.terminalId
    const filePath = this.filePath
    const requestVersion = this.loadRequestVersion + 1
    this.loadRequestVersion = requestVersion

    this.mode = 'loading'
    this.clearLoadedContent()
    this.dirty = false
    this.busy = false
    this.errorMessage = null
    this.statusMessage = null

    return await this.loadFileForRequest(terminalId, filePath, requestVersion)
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

  captureSnapshot(): FileEditorSnapshot {
    return {
      terminalId: this.terminalId,
      filePath: this.filePath,
      mode: this.mode,
      content: this.mode === 'text' ? this.content : '',
      dirty: this.dirty,
      errorMessage: this.errorMessage,
      statusMessage: this.statusMessage,
    }
  }

  restoreSnapshot(snapshot: FileEditorSnapshot | null | undefined): boolean {
    const normalized = normalizeFileEditorSnapshot(snapshot)
    if (!normalized) {
      return false
    }

    const requestVersion = this.loadRequestVersion + 1
    this.loadRequestVersion = requestVersion
    this.terminalId = normalized.terminalId
    this.filePath = normalized.filePath
    this.mode = normalized.mode === 'image' || normalized.mode === 'pdf' ? 'loading' : normalized.mode
    this.content = normalized.content
    this.contentBase64 = ''
    this.mimeType = ''
    this.fileSize = 0
    this.dirty = normalized.dirty
    this.busy = false
    this.errorMessage = normalized.errorMessage
    this.statusMessage = normalized.statusMessage
    if (
      (normalized.mode === 'loading' || normalized.mode === 'image' || normalized.mode === 'pdf') &&
      normalized.terminalId &&
      normalized.filePath
    ) {
      void this.loadFileForRequest(normalized.terminalId, normalized.filePath, requestVersion)
    }
    return true
  }

  clear(): void {
    this.loadRequestVersion += 1
    this.terminalId = null
    this.filePath = null
    this.mode = 'idle'
    this.clearLoadedContent()
    this.dirty = false
    this.busy = false
    this.errorMessage = null
    this.statusMessage = null
  }
}
