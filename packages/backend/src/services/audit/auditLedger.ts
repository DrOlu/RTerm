import { createHash, randomUUID } from 'crypto'

/**
 * auditLedger — hash-chained, tamper-evident audit trail for AI agent operations.
 *
 * Every audit-relevant event (agent runs, command evaluations, approvals,
 * MOP changes, playbook steps, trigger firings, alert ingestions, deep-dives)
 * is appended as a hash-chained record: each record includes the SHA-256 hash
 * of the previous record, forming an immutable chain. Any tampering with a
 * historical record breaks the chain and is detectable by re-computing hashes.
 *
 * Pure + injectable: the hash function and clock are injected; all storage
 * is in-memory (the caller persists to SQLite or file as needed).
 */

// --- Event types that the audit ledger records ---
export type AuditEventKind =
  | 'agent_run_start'
  | 'agent_run_end'
  | 'command_evaluated'
  | 'command_approved'
  | 'command_denied'
  | 'command_executed'
  | 'mop_plan'
  | 'mop_approve'
  | 'mop_run'
  | 'mop_rollback'
  | 'playbook_step'
  | 'trigger_fired'
  | 'netdata_alert'
  | 'aperf_deepdive'
  | 'config_change'
  | 'incident_created'
  | 'incident_updated'
  | 'evidence_sealed'

export interface AuditEvent {
  kind: AuditEventKind
  /** the actor (user, agent, system). */
  actor: string
  /** the target (host, playbook, command, etc.). */
  target: string
  /** human-readable summary. */
  summary: string
  /** structured detail (tool calls, policy verdict, step results, etc.). */
  detail?: Record<string, unknown>
  /** the timestamp. */
  at: number
}

export interface AuditRecord extends AuditEvent {
  /** unique record id. */
  id: string
  /** SHA-256 hash of this record's content (excluding hash + prevHash fields). */
  hash: string
  /** SHA-256 hash of the previous record (genesis = '0'.repeat(64)). */
  prevHash: string
  /** monotonically increasing sequence number. */
  seq: number
}

export interface AuditLedgerDeps {
  /** the hash function (default: SHA-256). */
  hashFn?: (data: string) => string
  /** the clock. */
  now?: () => number
}

const GENESIS_HASH = '0'.repeat(64)

/** Pure: compute the hash of a record's content. */
export function computeRecordHash(
  kind: string, actor: string, target: string, summary: string,
  detail: Record<string, unknown> | undefined, at: number, seq: number,
): string {
  const payload = JSON.stringify({ kind, actor, target, summary, detail, at, seq })
  return createHash('sha256').update(payload).digest('hex')
}

/** Pure: compute the full chain hash (content hash + prevHash). */
export function computeChainHash(record: Omit<AuditRecord, 'id' | 'hash'>): string {
  const contentHash = computeRecordHash(
    record.kind, record.actor, record.target, record.summary,
    record.detail, record.at, record.seq,
  )
  return createHash('sha256').update(contentHash + record.prevHash).digest('hex')
}

export class AuditLedger {
  private records: AuditRecord[] = []
  private readonly hashFn: (data: string) => string
  private readonly now: () => number

  constructor(deps: AuditLedgerDeps = {}) {
    this.hashFn = deps.hashFn ?? ((data: string) => createHash('sha256').update(data).digest('hex'))
    this.now = deps.now ?? (() => Date.now())
  }

  /** Append an event to the audit ledger. Returns the record with hash + chain. */
  append(event: Omit<AuditEvent, 'at'> & { at?: number }): AuditRecord {
    const seq = this.records.length + 1
    const at = event.at ?? this.now()
    const prevHash = this.records.length > 0 ? this.records[this.records.length - 1].hash : GENESIS_HASH

    const contentHash = computeRecordHash(
      event.kind, event.actor, event.target, event.summary,
      event.detail, at, seq,
    )
    const hash = createHash('sha256').update(contentHash + prevHash).digest('hex')

    const record: AuditRecord = {
      id: `audit-${randomUUID().slice(0, 12)}`,
      kind: event.kind,
      actor: event.actor,
      target: event.target,
      summary: event.summary,
      ...(event.detail ? { detail: event.detail } : {}),
      at,
      seq,
      hash,
      prevHash,
    }

    this.records.push(record)
    return record
  }

  /** Get all records (ordered by seq). */
  list(): AuditRecord[] {
    return [...this.records]
  }

  /** Get records by kind. */
  listByKind(kind: AuditEventKind): AuditRecord[] {
    return this.records.filter((r) => r.kind === kind)
  }

  /** Get records for a specific target. */
  listByTarget(target: string): AuditRecord[] {
    return this.records.filter((r) => r.target === target)
  }

  /** Get records for a specific actor. */
  listByActor(actor: string): AuditRecord[] {
    return this.records.filter((r) => r.actor === actor)
  }

  /** Get records in a time range. */
  listInRange(fromAt: number, toAt: number): AuditRecord[] {
    return this.records.filter((r) => r.at >= fromAt && r.at <= toAt)
  }

  /** Verify the hash chain integrity. Returns { valid: true } or { valid: false, brokenAt: seq }. */
  verify(): { valid: boolean; brokenAt?: number; detail?: string } {
    if (this.records.length === 0) return { valid: true }

    for (let i = 0; i < this.records.length; i++) {
      const record = this.records[i]

      // Verify seq is monotonic.
      if (record.seq !== i + 1) {
        return { valid: false, brokenAt: record.seq, detail: `seq mismatch: expected ${i + 1}, got ${record.seq}` }
      }

      // Verify content hash.
      const expectedContentHash = computeRecordHash(
        record.kind, record.actor, record.target, record.summary,
        record.detail, record.at, record.seq,
      )
      const expectedHash = createHash('sha256').update(expectedContentHash + record.prevHash).digest('hex')
      if (record.hash !== expectedHash) {
        return { valid: false, brokenAt: record.seq, detail: `hash mismatch at seq ${record.seq}` }
      }

      // Verify prevHash chain.
      const expectedPrevHash = i === 0 ? GENESIS_HASH : this.records[i - 1].hash
      if (record.prevHash !== expectedPrevHash) {
        return { valid: false, brokenAt: record.seq, detail: `prevHash mismatch at seq ${record.seq}` }
      }
    }

    return { valid: true }
  }

  /** Get the current chain tip (the latest record's hash). */
  tip(): string {
    if (this.records.length === 0) return GENESIS_HASH
    return this.records[this.records.length - 1].hash
  }

  /** Get the total number of records. */
  size(): number {
    return this.records.length
  }

  /** Export all records as JSON (for persistence). */
  export(): string {
    return JSON.stringify(this.records, null, 2)
  }

  /** Import records from JSON (for recovery). Verifies the chain on import. */
  import(json: string): { imported: number; valid: boolean; detail?: string } {
    const parsed = JSON.parse(json) as AuditRecord[]
    if (!Array.isArray(parsed)) {
      return { imported: 0, valid: false, detail: 'not an array' }
    }

    // Verify the chain before importing.
    const tempLedger = new AuditLedger({ hashFn: this.hashFn, now: this.now })
    tempLedger.records = parsed
    const result = tempLedger.verify()
    if (!result.valid) {
      return { imported: 0, valid: false, detail: result.detail }
    }

    this.records = parsed
    return { imported: parsed.length, valid: true }
  }
}
