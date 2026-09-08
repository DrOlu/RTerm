import fs from 'node:fs/promises'
import path from 'node:path'

export interface MemorySnapshot {
  filePath: string
  content: string
}

export interface FileMemoryStoreOptions {
  getMemoryFilePath: () => string | Promise<string>
  defaultContent?: string
}

const DEFAULT_MEMORY_CONTENT = ['# Memory', '', '- Add durable cross-session notes here.', ''].join('\n')

export class FileMemoryStore {
  constructor(private readonly options: FileMemoryStoreOptions) {}

  async getMemoryFilePath(): Promise<string> {
    return await this.options.getMemoryFilePath()
  }

  async ensureMemoryFile(): Promise<string> {
    const filePath = await this.getMemoryFilePath()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false)
    if (!exists) {
      await fs.writeFile(filePath, this.options.defaultContent ?? DEFAULT_MEMORY_CONTENT, 'utf8')
    }
    return filePath
  }

  async readMemory(): Promise<string> {
    const filePath = await this.ensureMemoryFile()
    return await fs.readFile(filePath, 'utf8')
  }

  async writeMemory(content: string): Promise<MemorySnapshot> {
    const filePath = await this.ensureMemoryFile()
    await fs.writeFile(filePath, content, 'utf8')
    return {
      filePath,
      content
    }
  }

  /** Append text to memory.md (used by auto-lesson writer). */
  async appendMemory(chunk: string): Promise<MemorySnapshot> {
    const filePath = await this.ensureMemoryFile()
    const current = await fs.readFile(filePath, 'utf8')
    const next = current.endsWith('\n') || current === '' ? current + chunk : current + '\n' + chunk
    await fs.writeFile(filePath, next, 'utf8')
    return { filePath, content: next }
  }

  async getMemorySnapshot(): Promise<MemorySnapshot> {
    const filePath = await this.ensureMemoryFile()
    const content = await fs.readFile(filePath, 'utf8')
    return {
      filePath,
      content
    }
  }
}
