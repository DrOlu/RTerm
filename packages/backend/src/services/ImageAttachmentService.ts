import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { detectFileKind, readImageFile } from './AgentHelper/tools/read_tools'
import type { InputImageAttachment } from '../types'

export interface SaveImageAttachmentPayload {
  dataBase64: string
  fileName?: string
  mimeType?: string
  previewDataUrl?: string
}

interface StoredImageRecord {
  attachmentId: string
  filePath: string
  fileName: string
  mimeType: string
  sizeBytes: number
  sha256: string
  createdAt: number
  updatedAt: number
}

interface StoredImageIndex {
  records: Record<string, StoredImageRecord>
}

const DEFAULT_INDEX: StoredImageIndex = {
  records: {}
}

export class ImageAttachmentService {
  private readonly attachmentsDir: string
  private readonly indexPath: string
  private loaded = false
  private records: Record<string, StoredImageRecord> = {}

  constructor(private readonly dataDir: string) {
    this.attachmentsDir = path.join(this.dataDir, 'image_attachments')
    this.indexPath = path.join(this.attachmentsDir, 'index.json')
  }

  async saveImageAttachment(payload: SaveImageAttachmentPayload): Promise<InputImageAttachment> {
    await this.ensureLoaded()
    const bytes = this.decodeBase64(payload.dataBase64)
    const image = readImageFile({
      bytes: new Uint8Array(bytes),
      filePath: payload.fileName || 'upload'
    })
    const normalizedMimeType = this.resolveMimeType(payload.mimeType, image.mimeType)
    const extension = this.resolveImageExtension(payload.fileName, normalizedMimeType)
    const safeName = this.safeFileName(payload.fileName)
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    const attachmentId = `img_${sha256.slice(0, 24)}`
    const filePath = path.join(this.attachmentsDir, `${attachmentId}${extension}`)

    const existing = this.records[attachmentId]
    if (!existing) {
      await fs.writeFile(filePath, bytes)
      const now = Date.now()
      this.records[attachmentId] = {
        attachmentId,
        filePath,
        fileName: safeName,
        mimeType: normalizedMimeType,
        sizeBytes: bytes.byteLength,
        sha256,
        createdAt: now,
        updatedAt: now
      }
      await this.flushIndex()
    } else {
      this.records[attachmentId] = {
        ...existing,
        updatedAt: Date.now()
      }
      await this.flushIndex()
    }

    const current = this.records[attachmentId]
    return {
      attachmentId: current.attachmentId,
      fileName: current.fileName,
      mimeType: current.mimeType,
      sizeBytes: current.sizeBytes,
      sha256: current.sha256,
      status: 'ready',
      ...(payload.previewDataUrl ? { previewDataUrl: payload.previewDataUrl } : {})
    }
  }

  async loadImageBytes(ref: InputImageAttachment): Promise<{
    attachment: InputImageAttachment
    bytes: Uint8Array
  } | null> {
    const normalized = await this.resolveImageAttachment(ref)
    if (!normalized?.attachmentId) return null
    if (normalized.status === 'missing') {
      return {
        attachment: normalized,
        bytes: new Uint8Array()
      }
    }
    const record = this.records[normalized.attachmentId]
    if (!record) {
      return {
        attachment: {
          ...normalized,
          status: 'missing'
        },
        bytes: new Uint8Array()
      }
    }
    try {
      const bytes = await fs.readFile(record.filePath)
      const kind = detectFileKind(record.fileName || normalized.fileName || normalized.attachmentId, new Uint8Array(bytes))
      if (kind !== 'image') return null
      return {
        attachment: {
          ...normalized,
          status: 'ready'
        },
        bytes: new Uint8Array(bytes)
      }
    } catch {
      return {
        attachment: {
          ...normalized,
          status: 'missing'
        },
        bytes: new Uint8Array()
      }
    }
  }

  async resolveImageAttachment(ref: InputImageAttachment): Promise<InputImageAttachment | null> {
    await this.ensureLoaded()
    const attachmentId = String(ref.attachmentId || '').trim()
    if (!attachmentId) {
      return null
    }
    const record = this.records[attachmentId]
    if (!record) {
      return {
        attachmentId,
        fileName: ref.fileName,
        mimeType: ref.mimeType,
        sizeBytes: ref.sizeBytes,
        sha256: ref.sha256,
        previewDataUrl: ref.previewDataUrl,
        status: 'missing'
      }
    }
    const exists = await this.exists(record.filePath)
    return {
      attachmentId: record.attachmentId,
      fileName: ref.fileName || record.fileName,
      mimeType: ref.mimeType || record.mimeType,
      sizeBytes: typeof ref.sizeBytes === 'number' ? ref.sizeBytes : record.sizeBytes,
      sha256: ref.sha256 || record.sha256,
      previewDataUrl: ref.previewDataUrl,
      status: exists ? 'ready' : 'missing'
    }
  }

  private decodeBase64(dataBase64: string): Buffer {
    const raw = String(dataBase64 || '').trim()
    if (!raw) {
      throw new Error('Image base64 payload is empty.')
    }
    const dataUrlMatch = raw.match(/^data:[^;]+;base64,(.+)$/i)
    const base64 = dataUrlMatch ? dataUrlMatch[1] : raw
    return Buffer.from(base64, 'base64')
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    await fs.mkdir(this.attachmentsDir, { recursive: true })
    try {
      const raw = await fs.readFile(this.indexPath, 'utf8')
      const parsed = JSON.parse(raw) as StoredImageIndex
      this.records = parsed.records || {}
    } catch {
      this.records = {}
      await this.flushIndex()
    }
    this.loaded = true
  }

  private async flushIndex(): Promise<void> {
    const payload: StoredImageIndex = {
      records: this.records
    }
    await fs.writeFile(this.indexPath, JSON.stringify(payload || DEFAULT_INDEX, null, 2), 'utf8')
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await fs.stat(filePath)
      return true
    } catch {
      return false
    }
  }

  private safeFileName(fileName?: string): string {
    const base = path.basename(String(fileName || '').trim()) || 'upload.png'
    const cleaned = base
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
    return cleaned || 'upload.png'
  }

  private resolveMimeType(inputMime: string | undefined, fallbackMime: string): string {
    const mime = String(inputMime || '').trim().toLowerCase()
    if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif' || mime === 'image/webp') {
      return mime
    }
    return fallbackMime
  }

  private resolveImageExtension(fileName: string | undefined, mimeType: string): string {
    const ext = path.extname(String(fileName || '').trim()).toLowerCase()
    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.webp') {
      return ext
    }
    if (mimeType === 'image/png') return '.png'
    if (mimeType === 'image/jpeg') return '.jpg'
    if (mimeType === 'image/gif') return '.gif'
    if (mimeType === 'image/webp') return '.webp'
    return '.png'
  }
}
