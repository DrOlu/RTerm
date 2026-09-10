import path from 'node:path'
import { app } from 'electron'
import {
  FileAccessTokenStore,
  type AccessTokenInfo,
  type CreateAccessTokenResult
} from '../../access-token/FileAccessTokenStore'

function resolveStoreBaseDir(): string {
  const overrideDir = (process.env.GYSHELL_STORE_DIR || '').trim()
  if (overrideDir) {
    return overrideDir
  }

  if (app && typeof app.getPath === 'function') {
    try {
      return app.getPath('userData')
    } catch {
      // fall through
    }
  }

  return path.join(process.cwd(), '.gyshell-data')
}

export class AccessTokenService {
  private readonly store: FileAccessTokenStore

  constructor() {
    const baseDir = resolveStoreBaseDir()
    this.store = new FileAccessTokenStore({
      filePath: path.join(baseDir, 'access-tokens.json')
    })
  }

  getStorageFilePath(): string {
    return this.store.getStorageFilePath()
  }

  async listTokens(): Promise<AccessTokenInfo[]> {
    return await this.store.list()
  }

  async createToken(name: string): Promise<CreateAccessTokenResult> {
    return await this.store.create(name)
  }

  async deleteToken(id: string): Promise<boolean> {
    return await this.store.delete(id)
  }

  async verifyToken(token: string): Promise<boolean> {
    return await this.store.verify(token)
  }

  async identifyToken(token: string): Promise<{ id: string; name: string } | null> {
    return await this.store.identify(token)
  }
}
