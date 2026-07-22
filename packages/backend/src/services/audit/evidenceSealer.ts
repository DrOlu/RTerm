import { createHash } from 'crypto'
import type { AuditLedger, AuditRecord } from './auditLedger'

/**
 * evidenceSealer — Merkle-tree sealing for the audit ledger.
 *
 * Periodically computes a Merkle tree root over the audit ledger records and
 * produces a sealed evidence bundle: the root hash + metadata (record count,
 * time range, tip hash) + the individual record hashes. The sealed bundle is
 * independently verifiable: anyone with the records can recompute the root
 * and compare it against the sealed root.
 *
 * This satisfies the KLA audit framework's "Evidence integrity, retention, and
 * independent verification" domain: the evidence is complete, tamper-evident,
 * retained, and independently testable.
 */

export interface EvidenceBundle {
  /** the Merkle root hash over all record hashes. */
  merkleRoot: string
  /** the number of records sealed. */
  recordCount: number
  /** the time range of sealed records. */
  fromAt: number
  toAt: number
  /** the audit ledger chain tip at seal time. */
  tipHash: string
  /** the individual record hashes (for verification). */
  recordHashes: string[]
  /** the seal timestamp. */
  sealedAt: number
  /** a unique seal id. */
  sealId: string
}

export interface EvidenceSealerDeps {
  now?: () => number
}

/** Pure: compute a Merkle root from a list of hex hashes. */
export function computeMerkleRoot(hashes: string[]): string {
  if (hashes.length === 0) return '0'.repeat(64)
  if (hashes.length === 1) return hashes[0]

  // Pair up hashes and hash each pair.
  const nextLevel: string[] = []
  for (let i = 0; i < hashes.length; i += 2) {
    const left = hashes[i]
    const right = i + 1 < hashes.length ? hashes[i + 1] : left // duplicate last if odd
    nextLevel.push(createHash('sha256').update(left + right).digest('hex'))
  }
  return computeMerkleRoot(nextLevel)
}

/** Pure: verify a Merkle root against a list of hashes. */
export function verifyMerkleRoot(hashes: string[], expectedRoot: string): boolean {
  return computeMerkleRoot(hashes) === expectedRoot
}

export class EvidenceSealer {
  private bundles: EvidenceBundle[] = []
  private readonly now: () => number

  constructor(deps: EvidenceSealerDeps = {}) {
    this.now = deps.now ?? (() => Date.now())
  }

  /** Seal the current state of the audit ledger into an evidence bundle. */
  seal(ledger: AuditLedger, sealId?: string): EvidenceBundle {
    const records = ledger.list()
    const recordHashes = records.map((r) => r.hash)
    const merkleRoot = computeMerkleRoot(recordHashes)

    const bundle: EvidenceBundle = {
      merkleRoot,
      recordCount: records.length,
      fromAt: records.length > 0 ? records[0].at : 0,
      toAt: records.length > 0 ? records[records.length - 1].at : 0,
      tipHash: ledger.tip(),
      recordHashes,
      sealedAt: this.now(),
      sealId: sealId ?? `seal-${Date.now().toString(36)}`,
    }

    this.bundles.push(bundle)
    return bundle
  }

  /** Verify a sealed bundle against a set of records. */
  verify(bundle: EvidenceBundle, records: AuditRecord[]): { valid: boolean; detail?: string } {
    // Check record count.
    if (records.length !== bundle.recordCount) {
      return { valid: false, detail: `record count mismatch: expected ${bundle.recordCount}, got ${records.length}` }
    }

    // Check tip hash.
    if (records.length > 0 && records[records.length - 1].hash !== bundle.tipHash) {
      return { valid: false, detail: `tip hash mismatch` }
    }

    // Check Merkle root.
    const hashes = records.map((r) => r.hash)
    if (!verifyMerkleRoot(hashes, bundle.merkleRoot)) {
      return { valid: false, detail: `Merkle root mismatch` }
    }

    return { valid: true }
  }

  /** Get all sealed bundles. */
  listBundles(): EvidenceBundle[] {
    return [...this.bundles]
  }

  /** Get the latest sealed bundle. */
  latest(): EvidenceBundle | undefined {
    return this.bundles.length > 0 ? this.bundles[this.bundles.length - 1] : undefined
  }
}
