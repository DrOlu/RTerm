import { extname } from 'node:path'
import type { FileSystemEntry } from '../types'
import type { TerminalService } from './TerminalService'

const DEFAULT_TEXT_MAX_BYTES = 1024 * 1024
const DEFAULT_BASE64_MAX_BYTES = 32 * 1024 * 1024
const DEFAULT_TRANSFER_CHUNK_SIZE = 1024 * 1024
const MIN_TRANSFER_CHUNK_SIZE = 16 * 1024
// MAX intentionally equals DEFAULT: callers cannot request larger chunks so that
// per-chunk memory allocation stays bounded regardless of what the UI sends.
const MAX_TRANSFER_CHUNK_SIZE = 1024 * 1024
export const FILESYSTEM_TRANSFER_CANCELLED_CODE = 'GYSHELL_FS_TRANSFER_CANCELLED'
export const FILESYSTEM_DOWNLOAD_CANCELLED_CODE = FILESYSTEM_TRANSFER_CANCELLED_CODE

export interface ReadTextFileResult {
  path: string
  content: string
  size: number
  encoding: 'utf8'
}

export interface ReadBase64FileResult {
  path: string
  contentBase64: string
  size: number
  mimeType: string
}

export type FileTransferMode = 'copy' | 'move'

export interface TransferEntriesProgress {
  transferId?: string
  mode: FileTransferMode
  bytesTransferred: number
  totalBytes: number
  transferredFiles: number
  totalFiles: number
  eof: boolean
}

export interface TransferEntriesResult {
  mode: FileTransferMode
  totalBytes: number
  transferredFiles: number
  totalFiles: number
}

interface TransferNode {
  sourcePath: string
  name: string
  isDirectory: boolean
  size: number
  fileCount: number
  children: TransferNode[]
}

interface TransferRootPlan {
  sourcePath: string
  targetPath: string
  targetAlreadyExisted: boolean
  removeExistingTarget: boolean
  node: TransferNode
}

const createTransferCancelledError = (): Error & { code: string } => {
  const error = new Error('Transfer cancelled by user.') as Error & { code: string }
  error.code = FILESYSTEM_TRANSFER_CANCELLED_CODE
  return error
}

export const isFileSystemTransferCancelledError = (error: unknown): boolean => {
  const maybeError = error as { code?: unknown; message?: unknown } | null
  return maybeError?.code === FILESYSTEM_TRANSFER_CANCELLED_CODE
}

export const isFileSystemDownloadCancelledError = isFileSystemTransferCancelledError

const isAbortLikeError = (error: unknown): boolean => {
  const maybeError = error as { name?: unknown; code?: unknown; message?: unknown } | null
  return maybeError?.name === 'AbortError' || maybeError?.code === 'ABORT_ERR'
}

export class FileSystemService {
  constructor(private readonly terminalService: TerminalService) {}

  async listDirectory(terminalId: string, dirPath?: string): Promise<{ path: string; entries: FileSystemEntry[] }> {
    return await this.terminalService.listDirectory(terminalId, dirPath)
  }

  async createDirectory(terminalId: string, dirPath: string): Promise<void> {
    await this.terminalService.createDirectory(terminalId, dirPath)
  }

  async createFile(terminalId: string, filePath: string): Promise<void> {
    await this.terminalService.createFile(terminalId, filePath)
  }

  async deletePath(terminalId: string, targetPath: string, options?: { recursive?: boolean }): Promise<void> {
    await this.terminalService.deletePath(terminalId, targetPath, options)
  }

  async renamePath(terminalId: string, sourcePath: string, targetPath: string): Promise<void> {
    await this.terminalService.renamePath(terminalId, sourcePath, targetPath)
  }

  async readTextFile(
    terminalId: string,
    filePath: string,
    options?: { maxBytes?: number }
  ): Promise<ReadTextFileResult> {
    const stat = await this.terminalService.statFile(terminalId, filePath)
    if (!stat.exists) {
      throw new Error(`File not found: ${filePath}`)
    }
    if (stat.isDirectory) {
      throw new Error(`Path is a directory: ${filePath}`)
    }

    const maxBytes = this.resolvePositiveMaxBytes(options?.maxBytes, DEFAULT_TEXT_MAX_BYTES)
    // Use the size already obtained from statFile when available; fall back to a
    // readFileChunk probe only for backends that do not yet return size from stat.
    const probedSize = stat.size !== undefined
      ? Math.max(0, Number(stat.size) || 0)
      : await this.resolveFileSize(terminalId, filePath)
    if (probedSize > maxBytes) {
      throw new Error(`File is too large for text read (${probedSize} bytes > ${maxBytes} bytes).`)
    }

    const bytes = await this.terminalService.readFile(terminalId, filePath)
    // Keep a post-read guard for race conditions where file size changes after probing.
    if (bytes.length > maxBytes) {
      throw new Error(`File is too large for text read (${bytes.length} bytes > ${maxBytes} bytes).`)
    }
    if (this.isLikelyBinary(filePath, bytes)) {
      throw new Error(`File appears to be binary and cannot be opened as text: ${filePath}`)
    }

    return {
      path: filePath,
      content: bytes.toString('utf8'),
      size: bytes.length,
      encoding: 'utf8'
    }
  }

  async readFileBase64(
    terminalId: string,
    filePath: string,
    options?: { maxBytes?: number }
  ): Promise<ReadBase64FileResult> {
    const stat = await this.terminalService.statFile(terminalId, filePath)
    if (!stat.exists) {
      throw new Error(`File not found: ${filePath}`)
    }
    if (stat.isDirectory) {
      throw new Error(`Path is a directory: ${filePath}`)
    }

    const maxBytes = this.resolvePositiveMaxBytes(options?.maxBytes, DEFAULT_BASE64_MAX_BYTES)
    const probedSize = stat.size !== undefined
      ? Math.max(0, Number(stat.size) || 0)
      : await this.resolveFileSize(terminalId, filePath)
    if (probedSize > maxBytes) {
      throw new Error(`File is too large to transfer (${probedSize} bytes > ${maxBytes} bytes).`)
    }

    const bytes = await this.terminalService.readFile(terminalId, filePath)
    // Keep a post-read guard for race conditions where file size changes after probing.
    if (bytes.length > maxBytes) {
      throw new Error(`File is too large to transfer (${bytes.length} bytes > ${maxBytes} bytes).`)
    }

    return {
      path: filePath,
      contentBase64: bytes.toString('base64'),
      size: bytes.length,
      mimeType: this.guessMimeType(filePath)
    }
  }

  async writeTextFile(terminalId: string, filePath: string, content: string): Promise<void> {
    await this.terminalService.writeFile(terminalId, filePath, content)
  }

  async writeFileBase64(
    terminalId: string,
    filePath: string,
    contentBase64: string,
    options?: { maxBytes?: number }
  ): Promise<void> {
    if (typeof contentBase64 !== 'string') {
      throw new Error('contentBase64 must be a base64 string.')
    }
    const buffer = Buffer.from(contentBase64, 'base64')
    const maxBytes = Number.isFinite(options?.maxBytes) && (options?.maxBytes || 0) > 0
      ? Math.floor(options!.maxBytes as number)
      : DEFAULT_BASE64_MAX_BYTES
    if (buffer.length > maxBytes) {
      throw new Error(`Payload is too large (${buffer.length} bytes > ${maxBytes} bytes).`)
    }
    await this.terminalService.writeFileBytes(terminalId, filePath, buffer)
  }

  async transferEntries(
    sourceTerminalId: string,
    sourcePaths: string[],
    targetTerminalId: string,
    targetDirPath: string,
    options?: {
      mode?: FileTransferMode
      overwrite?: boolean
      chunkSize?: number
      transferId?: string
      signal?: AbortSignal
      onProgress?: (progress: TransferEntriesProgress) => void
    }
  ): Promise<TransferEntriesResult> {
    const mode: FileTransferMode = options?.mode === 'move' ? 'move' : 'copy'
    const overwrite = options?.overwrite === true
    const chunkSize = this.normalizeChunkSize(options?.chunkSize)
    const sourceList = sourcePaths
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0)
    if (sourceList.length <= 0) {
      throw new Error('sourcePaths must contain at least one path.')
    }

    const targetDirStat = await this.terminalService.statFile(targetTerminalId, targetDirPath)
    if (!targetDirStat.exists || !targetDirStat.isDirectory) {
      throw new Error(`Target directory does not exist: ${targetDirPath}`)
    }

    const sourceOs = this.terminalService.getRemoteOs(sourceTerminalId)
    const targetOs = this.terminalService.getRemoteOs(targetTerminalId)
    const sourceType = this.terminalService.getTerminalType(sourceTerminalId)
    const targetType = this.terminalService.getTerminalType(targetTerminalId)
    const sourceFileSystemIdentity = this.terminalService.getFileSystemIdentity(sourceTerminalId)
    const targetFileSystemIdentity = this.terminalService.getFileSystemIdentity(targetTerminalId)
    const sameFileSystem = !!sourceFileSystemIdentity
      && !!targetFileSystemIdentity
      && sourceFileSystemIdentity === targetFileSystemIdentity
    const compareOs = sourceOs ?? targetOs

    const rootPlans: TransferRootPlan[] = []
    const targetPathSet = new Set<string>()
    const seenSources = new Set<string>()
    for (const sourcePath of sourceList) {
      const resolvedSourcePath = await this.terminalService.resolvePathForFileSystem(sourceTerminalId, sourcePath)
      const sourceKey = this.normalizePathForCompare(resolvedSourcePath, sourceOs)
      if (seenSources.has(sourceKey)) continue
      seenSources.add(sourceKey)

      const node = await this.buildTransferNode(sourceTerminalId, resolvedSourcePath)
      const targetPath = this.joinPathForOs(targetDirPath, node.name, targetOs)
      const resolvedTargetPath = await this.terminalService.resolvePathForFileSystem(targetTerminalId, targetPath)

      if (sameFileSystem && this.pathsEqual(resolvedSourcePath, resolvedTargetPath, compareOs)) {
        if (mode === 'copy') {
          throw new Error(`Source and target are identical: ${resolvedSourcePath}`)
        }
        continue
      }
      if (
        mode === 'move'
        && sameFileSystem
        && node.isDirectory
        && this.isSameOrDescendantPath(resolvedTargetPath, resolvedSourcePath, compareOs)
      ) {
        throw new Error(`Cannot move directory into itself or a descendant: ${resolvedSourcePath}`)
      }

      const targetKey = this.normalizePathForCompare(resolvedTargetPath, targetOs)
      if (targetPathSet.has(targetKey)) {
        throw new Error(`Duplicate target path in transfer batch: ${resolvedTargetPath}`)
      }
      targetPathSet.add(targetKey)

      const targetStat = await this.terminalService.statFile(targetTerminalId, resolvedTargetPath)
      if (targetStat.exists && !overwrite) {
        throw new Error(`Target path already exists: ${resolvedTargetPath}`)
      }

      rootPlans.push({
        sourcePath: resolvedSourcePath,
        targetPath: resolvedTargetPath,
        targetAlreadyExisted: targetStat.exists,
        removeExistingTarget: targetStat.exists && overwrite && !(node.isDirectory && targetStat.isDirectory),
        node
      })
    }

    if (rootPlans.length <= 0) {
      return {
        mode,
        totalBytes: 0,
        transferredFiles: 0,
        totalFiles: 0
      }
    }

    const totalBytes = rootPlans.reduce((sum, item) => sum + item.node.size, 0)
    const totalFiles = rootPlans.reduce((sum, item) => sum + item.node.fileCount, 0)
    const progressState = {
      bytesTransferred: 0,
      transferredFiles: 0
    }
    const notifyProgress = (eof: boolean): void => {
      options?.onProgress?.({
        transferId: options?.transferId,
        mode,
        bytesTransferred: progressState.bytesTransferred,
        totalBytes,
        transferredFiles: progressState.transferredFiles,
        totalFiles,
        eof
      })
    }
    const ensureNotCancelled = (): void => {
      if (options?.signal?.aborted) {
        throw createTransferCancelledError()
      }
    }
    const createdTargetRoots: string[] = []
    let copyPhaseCompleted = false

    try {
      notifyProgress(false)
      for (const plan of rootPlans) {
        ensureNotCancelled()
        if (plan.removeExistingTarget) {
          await this.terminalService.deletePath(targetTerminalId, plan.targetPath, { recursive: true })
        }
        if (!plan.targetAlreadyExisted || plan.removeExistingTarget) {
          createdTargetRoots.push(plan.targetPath)
        }
        await this.copyTransferNode({
          sourceTerminalId,
          targetTerminalId,
          sourceType,
          targetType,
          targetOs,
          chunkSize,
          node: plan.node,
          targetPath: plan.targetPath,
          progressState,
          ensureNotCancelled,
          signal: options?.signal,
          overwrite,
          notifyProgress,
          createdTargetPaths: createdTargetRoots
        })
      }
      copyPhaseCompleted = true

      if (mode === 'move') {
        ensureNotCancelled()
        for (const plan of rootPlans) {
          await this.terminalService.deletePath(sourceTerminalId, plan.sourcePath, { recursive: true })
        }
      }

      notifyProgress(true)
      return {
        mode,
        totalBytes,
        transferredFiles: progressState.transferredFiles,
        totalFiles
      }
    } catch (error) {
      if (!copyPhaseCompleted) {
        for (const targetRoot of createdTargetRoots.reverse()) {
          await this.terminalService.deletePath(targetTerminalId, targetRoot, { recursive: true }).catch((rollbackErr) => {
            console.warn(`[FileSystemService] Rollback: failed to delete ${targetRoot}:`, rollbackErr)
          })
        }
      }
      if (options?.signal?.aborted || isAbortLikeError(error) || isFileSystemTransferCancelledError(error)) {
        throw createTransferCancelledError()
      }
      throw error
    }
  }

  private async copyTransferNode(params: {
    sourceTerminalId: string
    targetTerminalId: string
    sourceType: 'local' | 'ssh'
    targetType: 'local' | 'ssh'
    targetOs: 'unix' | 'windows' | undefined
    chunkSize: number
    node: TransferNode
    targetPath: string
    progressState: { bytesTransferred: number; transferredFiles: number }
    ensureNotCancelled: () => void
    signal?: AbortSignal
    overwrite: boolean
    notifyProgress: (eof: boolean) => void
    createdTargetPaths: string[]
  }): Promise<void> {
    const {
      sourceTerminalId,
      targetTerminalId,
      sourceType,
      targetType,
      targetOs,
      chunkSize,
      node,
      targetPath,
      progressState,
      ensureNotCancelled,
      signal,
      overwrite,
      notifyProgress,
      createdTargetPaths
    } = params

    ensureNotCancelled()

    if (node.isDirectory) {
      if (overwrite) {
        const targetStat = await this.terminalService.statFile(targetTerminalId, targetPath)
        if (targetStat.exists && !targetStat.isDirectory) {
          await this.terminalService.deletePath(targetTerminalId, targetPath, { recursive: true })
          await this.terminalService.createDirectory(targetTerminalId, targetPath)
          createdTargetPaths.push(targetPath)
        } else if (!targetStat.exists) {
          await this.terminalService.createDirectory(targetTerminalId, targetPath)
          createdTargetPaths.push(targetPath)
        }
      } else {
        await this.terminalService.createDirectory(targetTerminalId, targetPath)
        createdTargetPaths.push(targetPath)
      }
      for (const child of node.children) {
        const childTargetPath = this.joinPathForOs(targetPath, child.name, targetOs)
        await this.copyTransferNode({
          sourceTerminalId,
          targetTerminalId,
          sourceType,
          targetType,
          targetOs,
          chunkSize,
          node: child,
          targetPath: childTargetPath,
          progressState,
          ensureNotCancelled,
          signal,
          overwrite,
          notifyProgress,
          createdTargetPaths
        })
      }
      return
    }

    if (overwrite) {
      const targetStat = await this.terminalService.statFile(targetTerminalId, targetPath)
      if (targetStat.exists && targetStat.isDirectory) {
        await this.terminalService.deletePath(targetTerminalId, targetPath, { recursive: true })
      }
    }

    await this.copyFileBetweenTerminals({
      sourceTerminalId,
      sourceType,
      sourcePath: node.sourcePath,
      targetTerminalId,
      targetType,
      targetPath,
      chunkSize,
      fileSize: node.size,
      ensureNotCancelled,
      signal,
      onChunkWritten: (bytesWritten) => {
        progressState.bytesTransferred += bytesWritten
        notifyProgress(false)
      }
    })

    progressState.transferredFiles += 1
    notifyProgress(false)
  }

  private async copyFileBetweenTerminals(params: {
    sourceTerminalId: string
    sourceType: 'local' | 'ssh'
    sourcePath: string
    targetTerminalId: string
    targetType: 'local' | 'ssh'
    targetPath: string
    chunkSize: number
    fileSize: number
    ensureNotCancelled: () => void
    signal?: AbortSignal
    onChunkWritten: (bytesWritten: number) => void
  }): Promise<void> {
    const {
      sourceTerminalId,
      sourceType,
      sourcePath,
      targetTerminalId,
      targetType,
      targetPath,
      chunkSize,
      fileSize,
      ensureNotCancelled,
      signal,
      onChunkWritten
    } = params

    if (fileSize <= 0) {
      await this.terminalService.writeFileChunk(targetTerminalId, targetPath, 0, Buffer.alloc(0), { truncate: true })
      return
    }

    if (sourceType === 'local' && (targetType === 'ssh' || targetType === 'local')) {
      let lastTransferred = 0
      const uploaded = await this.terminalService.uploadFileFromLocalPath(
        targetTerminalId,
        sourcePath,
        targetPath,
        {
          signal,
          onProgress: (progress) => {
            const current = Math.max(0, Number(progress.bytesTransferred) || 0)
            const delta = Math.max(0, current - lastTransferred)
            lastTransferred = current
            if (delta > 0) {
              onChunkWritten(delta)
            }
          }
        }
      )
      if (uploaded) {
        if (uploaded.totalBytes > lastTransferred) {
          onChunkWritten(uploaded.totalBytes - lastTransferred)
        }
        return
      }
    }

    if (sourceType === 'ssh' && targetType === 'local') {
      let lastTransferred = 0
      const downloaded = await this.terminalService.downloadFileToLocalPath(
        sourceTerminalId,
        sourcePath,
        targetPath,
        {
          signal,
          onProgress: (progress) => {
            const current = Math.max(0, Number(progress.bytesTransferred) || 0)
            const delta = Math.max(0, current - lastTransferred)
            lastTransferred = current
            if (delta > 0) {
              onChunkWritten(delta)
            }
          }
        }
      )
      if (downloaded) {
        if (downloaded.totalBytes > lastTransferred) {
          onChunkWritten(downloaded.totalBytes - lastTransferred)
        }
        return
      }
    }

    let offset = 0
    let totalSizeHint: number | undefined = fileSize
    while (true) {
      ensureNotCancelled()
      const chunk = await this.terminalService.readFileChunk(
        sourceTerminalId,
        sourcePath,
        offset,
        chunkSize,
        totalSizeHint !== undefined ? { totalSizeHint } : undefined
      )
      totalSizeHint = chunk.totalSize

      if (chunk.bytesRead > 0) {
        await this.terminalService.writeFileChunk(
          targetTerminalId,
          targetPath,
          offset,
          chunk.chunk,
          { truncate: offset === 0 }
        )
        onChunkWritten(chunk.bytesRead)
      }

      offset = chunk.nextOffset
      if (chunk.eof) {
        break
      }
      if (chunk.bytesRead <= 0) {
        throw new Error(`Unexpected zero-length chunk while copying file: ${sourcePath}`)
      }
    }
  }

  private async buildTransferNode(terminalId: string, sourcePath: string): Promise<TransferNode> {
    // NOTE: This method recursively scans the full directory tree into memory before
    // any bytes are transferred. This trade-off allows totalFiles/totalBytes to be known
    // upfront for accurate progress reporting. For very large directories the discovery
    // phase may take noticeable time before transfer begins.
    const stat = await this.terminalService.statFile(terminalId, sourcePath)
    if (!stat.exists) {
      throw new Error(`Source path not found: ${sourcePath}`)
    }

    const osType = this.terminalService.getRemoteOs(terminalId)
    const name = this.basenamePathForOs(sourcePath, osType)
    if (!name) {
      throw new Error(`Invalid source path: ${sourcePath}`)
    }

    if (!stat.isDirectory) {
      // Prefer the size from stat to avoid a redundant readFileChunk round-trip.
      const size = stat.size !== undefined
        ? Math.max(0, Number(stat.size) || 0)
        : await this.resolveFileSize(terminalId, sourcePath)
      return {
        sourcePath,
        name,
        isDirectory: false,
        size,
        fileCount: 1,
        children: []
      }
    }

    const listed = await this.terminalService.listDirectory(terminalId, sourcePath)
    const children: TransferNode[] = []
    for (const entry of listed.entries) {
      if (entry.isDirectory) {
        children.push(await this.buildTransferNode(terminalId, entry.path))
        continue
      }
      children.push({
        sourcePath: entry.path,
        name: entry.name,
        isDirectory: false,
        size: Math.max(0, Number(entry.size) || 0),
        fileCount: 1,
        children: []
      })
    }
    const size = children.reduce((sum, child) => sum + child.size, 0)
    const fileCount = children.reduce((sum, child) => sum + child.fileCount, 0)
    return {
      sourcePath,
      name,
      isDirectory: true,
      size,
      fileCount,
      children
    }
  }

  private async resolveFileSize(terminalId: string, filePath: string): Promise<number> {
    const probe = await this.terminalService.readFileChunk(terminalId, filePath, 0, 1)
    return Math.max(0, Number(probe.totalSize) || 0)
  }

  private joinPathForOs(basePath: string, childName: string, osType: 'unix' | 'windows' | undefined): string {
    const leaf = childName.replace(/^[\\/]+/, '')
    if (!basePath || basePath === '.') return leaf
    if (osType === 'windows') {
      if (/^[A-Za-z]:\\$/.test(basePath)) return `${basePath}${leaf}`
      const trimmedBase = basePath.replace(/[\\/]+$/, '')
      if (/^[A-Za-z]:$/.test(trimmedBase)) return `${trimmedBase}\\${leaf}`
      return `${trimmedBase}\\${leaf}`
    }
    if (basePath === '/') return `/${leaf}`
    return `${basePath.replace(/\/+$/, '')}/${leaf}`
  }

  private basenamePathForOs(inputPath: string, osType: 'unix' | 'windows' | undefined): string {
    const normalized = inputPath.trim()
    if (!normalized || normalized === '/') return ''

    if (osType === 'windows') {
      const withoutTail = normalized.replace(/[\\/]+$/, '')
      const parts = withoutTail.split(/[\\/]+/)
      const name = parts[parts.length - 1] || ''
      if (/^[A-Za-z]:$/.test(name)) return ''
      return name
    }

    const withoutTail = normalized.replace(/\/+$/, '')
    const index = withoutTail.lastIndexOf('/')
    if (index < 0) return withoutTail
    return withoutTail.slice(index + 1)
  }

  private normalizePathForCompare(inputPath: string, osType: 'unix' | 'windows' | undefined): string {
    const treatAsWindows = osType === 'windows'
      || (osType === undefined && (/^[A-Za-z]:[\\/]/.test(inputPath) || inputPath.includes('\\')))
    if (treatAsWindows) {
      return inputPath.replace(/\//g, '\\').replace(/[\\]+$/, '').toLowerCase()
    }
    return inputPath.replace(/[\/]+$/, '') || '/'
  }

  private pathsEqual(left: string, right: string, osType: 'unix' | 'windows' | undefined): boolean {
    return this.normalizePathForCompare(left, osType) === this.normalizePathForCompare(right, osType)
  }

  private isSameOrDescendantPath(
    candidatePath: string,
    sourcePath: string,
    osType: 'unix' | 'windows' | undefined
  ): boolean {
    const normalizedCandidate = this.normalizePathForCompare(candidatePath, osType)
    const normalizedSource = this.normalizePathForCompare(sourcePath, osType)
    if (normalizedCandidate === normalizedSource) return true
    const separator = osType === 'windows' ? '\\' : '/'
    return normalizedCandidate.startsWith(`${normalizedSource}${separator}`)
  }

  private normalizeChunkSize(chunkSize: number | undefined): number {
    if (!Number.isFinite(chunkSize) || (chunkSize || 0) <= 0) {
      return DEFAULT_TRANSFER_CHUNK_SIZE
    }
    const parsed = Math.floor(chunkSize as number)
    return Math.max(MIN_TRANSFER_CHUNK_SIZE, Math.min(parsed, MAX_TRANSFER_CHUNK_SIZE))
  }

  private resolvePositiveMaxBytes(maxBytes: number | undefined, fallback: number): number {
    if (!Number.isFinite(maxBytes) || (maxBytes || 0) <= 0) {
      return fallback
    }
    return Math.max(1, Math.floor(maxBytes as number))
  }

  private guessMimeType(filePath: string): string {
    const ext = extname(filePath).toLowerCase()
    switch (ext) {
      case '.png':
        return 'image/png'
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg'
      case '.gif':
        return 'image/gif'
      case '.webp':
        return 'image/webp'
      case '.pdf':
        return 'application/pdf'
      case '.json':
        return 'application/json'
      case '.md':
      case '.txt':
      case '.log':
      case '.yaml':
      case '.yml':
      case '.xml':
      case '.csv':
      case '.ini':
      case '.env':
      case '.js':
      case '.ts':
      case '.tsx':
      case '.jsx':
      case '.go':
      case '.py':
      case '.rs':
      case '.java':
      case '.c':
      case '.cpp':
      case '.h':
      case '.hpp':
      case '.sh':
      case '.zsh':
        return 'text/plain; charset=utf-8'
      default:
        return 'application/octet-stream'
    }
  }

  private isLikelyBinary(filePath: string, bytes: Uint8Array): boolean {
    const ext = extname(filePath).toLowerCase()
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.zip', '.tar', '.gz', '.7z', '.exe'].includes(ext)) {
      return true
    }
    if (bytes.length === 0) return false
    const sampleSize = Math.min(4096, bytes.length)
    let nonPrintableCount = 0
    for (let i = 0; i < sampleSize; i += 1) {
      const value = bytes[i]
      if (value === 0) return true
      if (value < 9 || (value > 13 && value < 32)) {
        nonPrintableCount += 1
      }
    }
    return nonPrintableCount / sampleSize > 0.3
  }
}
