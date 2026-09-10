import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

const scrypt = promisify(scryptCallback)

const FILE_SCHEMA_VERSION = 1
const HASH_KEY_LENGTH = 32
const TOKEN_NAME_MAX_LENGTH = 64

export interface AccessTokenInfo {
  id: string
  name: string
  createdAt: number
}

export interface CreateAccessTokenResult extends AccessTokenInfo {
  token: string
}

interface AccessTokenRecord {
  id: string
  name: string
  createdAt: number
  tokenSalt: string
  tokenHash: string
}

interface AccessTokenStorePayload {
  schemaVersion: number
  tokens: AccessTokenRecord[]
}

export interface FileAccessTokenStoreOptions {
  filePath: string
}

function normalizeTokenName(name: string): string {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
}

function makeDefaultPayload(): AccessTokenStorePayload {
  return {
    schemaVersion: FILE_SCHEMA_VERSION,
    tokens: []
  }
}

function randomTokenId(): string {
  return `atk_${randomBytes(12).toString('base64url')}`
}

function randomAccessTokenValue(): string {
  return `gys_at_${randomBytes(24).toString('base64url')}`
}

async function deriveTokenHash(token: string, tokenSaltBase64: string): Promise<Buffer> {
  const tokenSalt = Buffer.from(tokenSaltBase64, 'base64')
  return (await scrypt(token, tokenSalt, HASH_KEY_LENGTH)) as Buffer
}

function normalizeRecord(raw: unknown): AccessTokenRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  if (typeof item.id !== 'string' || !item.id.trim()) return null
  if (typeof item.name !== 'string' || !item.name.trim()) return null
  if (typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt)) return null
  if (typeof item.tokenSalt !== 'string' || !item.tokenSalt) return null
  if (typeof item.tokenHash !== 'string' || !item.tokenHash) return null
  return {
    id: item.id,
    name: item.name,
    createdAt: item.createdAt,
    tokenSalt: item.tokenSalt,
    tokenHash: item.tokenHash
  }
}

function normalizePayload(raw: unknown): AccessTokenStorePayload {
  if (!raw || typeof raw !== 'object') return makeDefaultPayload()
  const item = raw as Record<string, unknown>
  const tokens = Array.isArray(item.tokens)
    ? item.tokens.map((entry) => normalizeRecord(entry)).filter((entry): entry is AccessTokenRecord => !!entry)
    : []
  return {
    schemaVersion: FILE_SCHEMA_VERSION,
    tokens: tokens.sort((left, right) => right.createdAt - left.createdAt)
  }
}

export class FileAccessTokenStore {
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: FileAccessTokenStoreOptions) {}

  getStorageFilePath(): string {
    return this.options.filePath
  }

  async list(): Promise<AccessTokenInfo[]> {
    const payload = await this.readPayload()
    return payload.tokens.map((item) => ({
      id: item.id,
      name: item.name,
      createdAt: item.createdAt
    }))
  }

  async create(name: string): Promise<CreateAccessTokenResult> {
    const normalizedName = normalizeTokenName(name)
    if (!normalizedName) {
      throw new Error('Token name is required.')
    }
    if (normalizedName.length > TOKEN_NAME_MAX_LENGTH) {
      throw new Error(`Token name must be <= ${TOKEN_NAME_MAX_LENGTH} characters.`)
    }

    return this.runExclusive(async () => {
      const payload = await this.readPayload()
      const duplicate = payload.tokens.some((item) => item.name.toLowerCase() === normalizedName.toLowerCase())
      if (duplicate) {
        throw new Error(`Token name already exists: ${normalizedName}`)
      }

      const token = randomAccessTokenValue()
      const tokenSalt = randomBytes(16).toString('base64')
      const tokenHash = (await deriveTokenHash(token, tokenSalt)).toString('base64')
      const createdAt = Date.now()
      const record: AccessTokenRecord = {
        id: randomTokenId(),
        name: normalizedName,
        createdAt,
        tokenSalt,
        tokenHash
      }

      const next: AccessTokenStorePayload = {
        schemaVersion: FILE_SCHEMA_VERSION,
        tokens: [record, ...payload.tokens]
      }
      await this.writePayload(next)
      return {
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        token
      }
    })
  }

  async delete(id: string): Promise<boolean> {
    const normalizedId = String(id || '').trim()
    if (!normalizedId) return false

    return this.runExclusive(async () => {
      const payload = await this.readPayload()
      const nextTokens = payload.tokens.filter((item) => item.id !== normalizedId)
      if (nextTokens.length === payload.tokens.length) {
        return false
      }
      await this.writePayload({
        schemaVersion: FILE_SCHEMA_VERSION,
        tokens: nextTokens
      })
      return true
    })
  }

  async verify(tokenRaw: string): Promise<boolean> {
    const identified = await this.identify(tokenRaw)
    return identified !== null
  }

  /** Return the matching token's id+name, or null. Used as operator identity. */
  async identify(tokenRaw: string): Promise<{ id: string; name: string } | null> {
    const token = String(tokenRaw || '').trim()
    if (!token) return null

    const payload = await this.readPayload()
    for (const record of payload.tokens) {
      try {
        const expected = Buffer.from(record.tokenHash, 'base64')
        const actual = await deriveTokenHash(token, record.tokenSalt)
        if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
          return { id: record.id, name: record.name }
        }
      } catch {
        // Skip malformed record and continue checking other tokens.
      }
    }
    return null
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation)
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async ensureFileSystem(): Promise<void> {
    await fs.mkdir(path.dirname(this.options.filePath), { recursive: true })
  }

  private async readPayload(): Promise<AccessTokenStorePayload> {
    await this.ensureFileSystem()
    const exists = await fs
      .access(this.options.filePath)
      .then(() => true)
      .catch(() => false)
    if (!exists) {
      const payload = makeDefaultPayload()
      await this.writePayload(payload)
      return payload
    }

    const raw = await fs.readFile(this.options.filePath, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('Access token storage file is invalid JSON.')
    }
    return normalizePayload(parsed)
  }

  private async writePayload(payload: AccessTokenStorePayload): Promise<void> {
    await this.ensureFileSystem()
    const serialized = normalizePayload(payload)
    const tempPath = `${this.options.filePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tempPath, JSON.stringify(serialized, null, 2), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tempPath, this.options.filePath)
  }
}
