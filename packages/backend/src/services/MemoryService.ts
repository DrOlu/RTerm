import path from 'node:path'
import { app } from 'electron'
import { FileMemoryStore, type MemorySnapshot } from '../memory/FileMemoryStore'
import { normalizeAgentSettingProfileId } from './settings/agentSettings'

export type { MemorySnapshot }
export type MemoryProfileId = string | null | undefined

export class MemoryService {
  private resolveBaseDir(): string {
    const overrideDir = (process.env.GYSHELL_STORE_DIR || '').trim()
    if (overrideDir) {
      return overrideDir
    }
    return app.getPath('userData')
  }

  private resolveMemoryFilePath(profileId?: MemoryProfileId): string {
    const normalizedProfileId = normalizeAgentSettingProfileId(profileId)
    const baseDir = this.resolveBaseDir()
    if (!normalizedProfileId) {
      return path.join(baseDir, 'memory.md')
    }
    return path.join(
      baseDir,
      'agent-settings',
      normalizedProfileId,
      'memory.md',
    )
  }

  private createStore(profileId?: MemoryProfileId): FileMemoryStore {
    return new FileMemoryStore({
      getMemoryFilePath: () => this.resolveMemoryFilePath(profileId),
    })
  }

  async ensureMemoryFile(profileId?: MemoryProfileId): Promise<string> {
    return await this.createStore(profileId).ensureMemoryFile()
  }

  async getMemoryFilePath(profileId?: MemoryProfileId): Promise<string> {
    return await this.createStore(profileId).getMemoryFilePath()
  }

  async getMemorySnapshot(
    profileId?: MemoryProfileId,
  ): Promise<MemorySnapshot> {
    return await this.createStore(profileId).getMemorySnapshot()
  }

  async readMemory(profileId?: MemoryProfileId): Promise<string> {
    return await this.createStore(profileId).readMemory()
  }

  async writeMemory(
    content: string,
    profileId?: MemoryProfileId,
  ): Promise<MemorySnapshot> {
    return await this.createStore(profileId).writeMemory(content)
  }

  async copyMemory(
    sourceProfileId: MemoryProfileId,
    targetProfileId: MemoryProfileId,
  ): Promise<MemorySnapshot> {
    const content = await this.readMemory(sourceProfileId)
    return await this.writeMemory(content, targetProfileId)
  }
}
