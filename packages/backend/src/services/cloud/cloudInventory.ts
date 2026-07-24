/**
 * cloudInventory — read-only cloud resource inventory across AWS / GCP / Azure
 * (Tier 3). Normalizes each provider's "list instances" output into a single
 * CloudResource model that feeds the CMDB / infra monitor, so "what do I run"
 * spans on-prem (SSH/WinRM/k8s) and cloud.
 *
 * Pure + injectable: provider API calls are injected (aws/gcloud/az CLI or SDK);
 * this module normalizes + correlates. Credentials come from the secrets vault.
 */

import { randomUUID } from 'crypto'

export type CloudProvider = 'aws' | 'gcp' | 'azure'

export interface CloudResource {
  id: string
  provider: CloudProvider
  /** resource kind: vm/instance, db, bucket, cluster, function, etc. */
  kind: string
  name: string
  region?: string
  /** running/stopped/terminated/available/... */
  state?: string
  /** provider-native type (e.g. t3.large, e2-standard-2, Standard_D2s). */
  machineType?: string
  /** private/public IPs when present. */
  privateIp?: string
  publicIp?: string
  tags?: Record<string, string>
  /** raw provider payload (for drill-down). */
  raw?: unknown
}

export interface CloudAccount {
  provider: CloudProvider
  /** account id / project id / subscription id. */
  accountId: string
  /** display alias. */
  alias?: string
}

export interface CloudInventoryDeps {
  now?: () => number
  /** injected fetchers — return provider-native JSON for a list call. */
  fetchAwsInstances?: (account: CloudAccount) => Promise<unknown>
  fetchGcpInstances?: (account: CloudAccount) => Promise<unknown>
  fetchAzureVms?: (account: CloudAccount) => Promise<unknown>
}

// ─── Parsers (pure) — normalize each provider's list output ─────────────────

/** Parse `aws ec2 describe-instances` JSON into CloudResources. */
export function parseAwsInstances(payload: unknown, accountId = ''): CloudResource[] {
  const out: CloudResource[] = []
  const reservations = (payload as { Reservations?: unknown[] })?.Reservations ?? []
  for (const res of Array.isArray(reservations) ? reservations : []) {
    const instances = (res as { Instances?: unknown[] })?.Instances ?? []
    for (const inst of Array.isArray(instances) ? instances : []) {
      const i = inst as Record<string, unknown>
      const tags: Record<string, string> = {}
      for (const t of (i.Tags as Array<{ Key?: string; Value?: string }>) ?? []) {
        if (t?.Key) tags[t.Key] = t.Value ?? ''
      }
      out.push({
        id: `aws:${accountId}:${String(i.InstanceId ?? randomUUID())}`,
        provider: 'aws',
        kind: 'instance',
        name: tags['Name'] ?? String(i.InstanceId ?? ''),
        region: regionFromAz(i.Placement as { AvailabilityZone?: string }),
        state: (i.State as { Name?: string })?.Name,
        machineType: i.InstanceType as string | undefined,
        privateIp: i.PrivateIpAddress as string | undefined,
        publicIp: i.PublicIpAddress as string | undefined,
        tags: Object.keys(tags).length > 0 ? tags : undefined,
        raw: inst,
      })
    }
  }
  return out
}

function regionFromAz(placement: { AvailabilityZone?: string } | undefined): string | undefined {
  const az = placement?.AvailabilityZone
  return az ? az.replace(/[a-z]$/, '') : undefined
}

/** Parse `gcloud compute instances list` JSON into CloudResources. */
export function parseGcpInstances(payload: unknown, accountId = ''): CloudResource[] {
  const out: CloudResource[] = []
  const items = Array.isArray(payload) ? payload : (payload as { items?: unknown[] })?.items ?? []
  for (const inst of Array.isArray(items) ? items : []) {
    const i = inst as Record<string, unknown>
    const zone = String(i.zone ?? '')
    const region = zone.split('/').pop()?.replace(/-[a-z]$/, '')
    const nics = (i.networkInterfaces as Array<Record<string, unknown>>) ?? []
    const privateIp = nics[0]?.networkIP as string | undefined
    const accessCfgs = (nics[0]?.accessConfigs as Array<Record<string, unknown>>) ?? []
    const publicIp = accessCfgs[0]?.natIP as string | undefined
    out.push({
      id: `gcp:${accountId}:${String(i.id ?? i.name ?? randomUUID())}`,
      provider: 'gcp',
      kind: 'instance',
      name: String(i.name ?? ''),
      region,
      state: (i.status as string | undefined)?.toLowerCase(),
      machineType: String(i.machineType ?? '').split('/').pop(),
      privateIp,
      publicIp,
      tags: i.labels as Record<string, string> | undefined,
      raw: inst,
    })
  }
  return out
}

/** Parse `az vm list` JSON into CloudResources. */
export function parseAzureVms(payload: unknown, accountId = ''): CloudResource[] {
  const out: CloudResource[] = []
  const items = Array.isArray(payload) ? payload : (payload as { value?: unknown[] })?.value ?? []
  for (const vm of Array.isArray(items) ? items : []) {
    const v = vm as Record<string, unknown>
    const props = (v.properties as Record<string, unknown>) ?? {}
    out.push({
      id: `azure:${accountId}:${String(v.id ?? v.name ?? randomUUID())}`,
      provider: 'azure',
      kind: 'vm',
      name: String(v.name ?? ''),
      region: (v.location as string | undefined),
      state: (props.provisioningState as string | undefined)?.toLowerCase(),
      machineType: (props.hardwareProfile as { vmSize?: string })?.vmSize,
      tags: v.tags as Record<string, string> | undefined,
      raw: vm,
    })
  }
  return out
}

// ─── Inventory service ──────────────────────────────────────────────────────

export class CloudInventory {
  private readonly accounts = new Map<string, CloudAccount>()
  private readonly resources = new Map<string, CloudResource>()
  private readonly now: () => number
  private readonly deps: CloudInventoryDeps
  private lastSyncAt: number | null = null

  constructor(deps: CloudInventoryDeps = {}) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  /** Register a cloud account to inventory. */
  addAccount(account: CloudAccount): void {
    if (!account.accountId) throw new Error('account needs an accountId')
    this.accounts.set(`${account.provider}:${account.accountId}`, account)
  }

  removeAccount(provider: CloudProvider, accountId: string): boolean {
    const key = `${provider}:${accountId}`
    for (const r of [...this.resources.values()]) {
      if (r.provider === provider && r.id.includes(`:${accountId}:`)) this.resources.delete(r.id)
    }
    return this.accounts.delete(key)
  }

  listAccounts(): CloudAccount[] {
    return [...this.accounts.values()].sort((a, b) => a.provider.localeCompare(b.provider))
  }

  /** Pull + normalize inventory from every registered account (best-effort). */
  async sync(): Promise<{ added: number; errors: Array<{ account: string; error: string }> }> {
    const errors: Array<{ account: string; error: string }> = []
    let added = 0
    for (const account of this.accounts.values()) {
      try {
        const parsed = await this.fetchAccount(account)
        for (const r of parsed) {
          this.resources.set(r.id, r)
          added++
        }
      } catch (e) {
        errors.push({ account: `${account.provider}:${account.accountId}`, error: e instanceof Error ? e.message : String(e) })
      }
    }
    this.lastSyncAt = this.now()
    return { added, errors }
  }

  private async fetchAccount(account: CloudAccount): Promise<CloudResource[]> {
    switch (account.provider) {
      case 'aws': {
        if (!this.deps.fetchAwsInstances) throw new Error('no AWS fetcher injected')
        return parseAwsInstances(await this.deps.fetchAwsInstances(account), account.accountId)
      }
      case 'gcp': {
        if (!this.deps.fetchGcpInstances) throw new Error('no GCP fetcher injected')
        return parseGcpInstances(await this.deps.fetchGcpInstances(account), account.accountId)
      }
      case 'azure': {
        if (!this.deps.fetchAzureVms) throw new Error('no Azure fetcher injected')
        return parseAzureVms(await this.deps.fetchAzureVms(account), account.accountId)
      }
    }
  }

  /** Query inventory (filterable). */
  query(filter: { provider?: CloudProvider; kind?: string; state?: string; region?: string; tagKey?: string; tagValue?: string } = {}): CloudResource[] {
    let out = [...this.resources.values()]
    if (filter.provider) out = out.filter((r) => r.provider === filter.provider)
    if (filter.kind) out = out.filter((r) => r.kind === filter.kind)
    if (filter.state) out = out.filter((r) => r.state === filter.state)
    if (filter.region) out = out.filter((r) => r.region === filter.region)
    if (filter.tagKey) out = out.filter((r) => r.tags && r.tags[filter.tagKey!] !== undefined && (filter.tagValue === undefined || r.tags[filter.tagKey!] === filter.tagValue))
    return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name))
  }

  /** Aggregate counts by provider/state — for the dashboard. */
  summary(): { total: number; byProvider: Record<string, number>; byState: Record<string, number>; lastSyncAt: number | null } {
    const byProvider: Record<string, number> = {}
    const byState: Record<string, number> = {}
    for (const r of this.resources.values()) {
      byProvider[r.provider] = (byProvider[r.provider] ?? 0) + 1
      const st = r.state ?? 'unknown'
      byState[st] = (byState[st] ?? 0) + 1
    }
    return { total: this.resources.size, byProvider, byState, lastSyncAt: this.lastSyncAt }
  }
}
