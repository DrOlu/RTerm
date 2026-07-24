/**
 * secretsVault — first-class encrypted secret store for RTerm (Tier 1).
 *
 * Connection passwords, API keys, PATs, and plugin credentials live here —
 * encrypted at rest with AES-256-GCM over a scrypt-derived data key — and are
 * NEVER injected into LLM context. Secrets are resolved only at execution
 * time (env vars for a command, a password for an SSH connection) and every
 * access is auditable.
 *
 * Pure + injectable: crypto, RNG, and the clock are injected so tests are
 * deterministic and no real key material is required.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'crypto'

export interface SecretEntry {
  key: string
  /** ciphertext (base64): nonce || tag || encrypted. */
  blob: string
  /** free-form labels (service, scope, connection id). */
  labels?: Record<string, string>
  createdAt: number
  updatedAt: number
}

export interface SecretMeta {
  key: string
  labels?: Record<string, string>
  createdAt: number
  updatedAt: number
}

export interface SecretsVaultOptions {
  /** the master key (passphrase or raw bytes). Required to read/write. */
  masterKey?: string | Buffer
  /** KDF salt (default derived from a constant + key). */
  salt?: Buffer
  /** injected clock (default Date.now). */
  now?: () => number
  /** injected RNG for nonces (default randomBytes). */
  randomBytes?: (n: number) => Buffer
  /** audit hook — called on every get/set/delete/list (never with the value). */
  onAudit?: (action: 'get' | 'set' | 'delete' | 'list', key: string) => void
}

const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/
const NONCE_LEN = 12 // AES-GCM nonce

/** Derive a 32-byte data-encryption key from the master key (scrypt). */
export function deriveKey(masterKey: string | Buffer, salt: Buffer): Buffer {
  return scryptSync(masterKey, salt, 32)
}

function defaultSalt(masterKey: string | Buffer): Buffer {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from('rterm-secrets-v1'), Buffer.from(masterKey)]))
    .digest()
    .subarray(0, 16)
}

/** Encrypt a UTF-8 secret → base64(nonce || tag || ciphertext) using AES-256-GCM. */
export function encryptSecret(plaintext: string, key: Buffer, nonce: Buffer): string {
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, tag, ct]).toString('base64')
}

/** Decrypt base64(nonce || tag || ciphertext) → UTF-8 secret. Throws on tamper. */
export function decryptSecret(blob: string, key: Buffer): string {
  const buf = Buffer.from(blob, 'base64')
  if (buf.length < NONCE_LEN + 16) throw new Error('malformed secret blob')
  const nonce = buf.subarray(0, NONCE_LEN)
  const tag = buf.subarray(NONCE_LEN, NONCE_LEN + 16)
  const ct = buf.subarray(NONCE_LEN + 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

/** The encrypted secret store. Holds only ciphertext in memory. */
export class SecretsVault {
  private readonly entries = new Map<string, SecretEntry>()
  private readonly key: Buffer | null
  private readonly now: () => number
  private readonly rand: (n: number) => Buffer
  private readonly onAudit?: (action: 'get' | 'set' | 'delete' | 'list', key: string) => void

  constructor(opts: SecretsVaultOptions = {}) {
    this.now = opts.now ?? Date.now
    this.rand = opts.randomBytes ?? randomBytes
    this.onAudit = opts.onAudit
    if (opts.masterKey !== undefined) {
      const salt = opts.salt ?? defaultSalt(opts.masterKey)
      this.key = deriveKey(opts.masterKey, salt)
    } else {
      this.key = null // locked — no key provided
    }
  }

  /** True when a master key is loaded (vault unlocked). */
  unlocked(): boolean {
    return this.key !== null
  }

  private requireKey(): Buffer {
    if (!this.key) throw new Error('secrets vault is locked — provide a master key')
    return this.key
  }

  /** Store (or overwrite) a secret. Value is encrypted immediately. */
  set(key: string, value: string, labels?: Record<string, string>): void {
    if (!KEY_RE.test(key)) throw new Error(`invalid secret key: ${key}`)
    if (typeof value !== 'string' || value.length === 0) throw new Error('secret value must be a non-empty string')
    const k = this.requireKey()
    const blob = encryptSecret(value, k, this.rand(NONCE_LEN))
    const at = this.now()
    const existing = this.entries.get(key)
    this.entries.set(key, {
      key,
      blob,
      labels: labels ? { ...labels } : existing?.labels,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    })
    this.onAudit?.('set', key)
  }

  /** Retrieve + decrypt a secret. Throws if absent or locked. */
  get(key: string): string {
    const e = this.entries.get(key)
    if (!e) throw new Error(`secret not found: ${key}`)
    this.onAudit?.('get', key)
    return decryptSecret(e.blob, this.requireKey())
  }

  /** True if a key exists (no decryption). */
  has(key: string): boolean {
    return this.entries.has(key)
  }

  /** Delete a secret. Returns whether it existed. */
  delete(key: string): boolean {
    const existed = this.entries.delete(key)
    if (existed) this.onAudit?.('delete', key)
    return existed
  }

  /** List metadata (never values), optionally filtered by a label substring. */
  list(filter?: { labelKey?: string; labelValue?: string }): SecretMeta[] {
    this.onAudit?.('list', '*')
    let out = [...this.entries.values()]
    if (filter?.labelKey) {
      out = out.filter((e) => {
        const v = e.labels?.[filter.labelKey!]
        if (v === undefined) return false
        return filter.labelValue === undefined || v === filter.labelValue
      })
    }
    return out
      .map((e) => ({
        key: e.key,
        labels: e.labels ? { ...e.labels } : undefined,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      }))
      .sort((a, b) => a.key.localeCompare(b.key))
  }

  /** Number of stored secrets. */
  size(): number {
    return this.entries.size
  }

  /**
   * Resolve `${secret:key}` references in an env map → a concrete env for exec.
   * Secrets are materialized only here (never into LLM-visible strings by the
   * caller). Missing keys throw so a command never runs with a dangling ref.
   */
  resolveEnv(env: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) {
      const m = /^\$\{secret:([^}]+)\}$/.exec(v)
      out[k] = m ? this.get(m[1]) : v
    }
    return out
  }

  /** Export the encrypted store (ciphertext only) as JSON — safe to persist. */
  exportEncrypted(): string {
    return JSON.stringify({ version: 1, entries: [...this.entries.values()] })
  }

  /** Import a previously-exported encrypted store (ciphertext). Values stay encrypted. */
  importEncrypted(json: string): number {
    let parsed: { version?: number; entries?: SecretEntry[] }
    try {
      parsed = JSON.parse(json)
    } catch {
      throw new Error('invalid secrets vault export (not JSON)')
    }
    if (!Array.isArray(parsed.entries)) throw new Error('invalid secrets vault export (no entries)')
    let n = 0
    for (const e of parsed.entries) {
      if (!e || typeof e.key !== 'string' || typeof e.blob !== 'string') continue
      this.entries.set(e.key, {
        key: e.key,
        blob: e.blob,
        labels: e.labels,
        createdAt: e.createdAt ?? 0,
        updatedAt: e.updatedAt ?? 0,
      })
      n++
    }
    return n
  }
}

/** Constant-time master-key verification (compare derived keys). */
export function verifyMasterKey(a: string | Buffer, b: string | Buffer, salt: Buffer): boolean {
  const ka = deriveKey(a, salt)
  const kb = deriveKey(b, salt)
  return timingSafeEqual(ka, kb)
}
