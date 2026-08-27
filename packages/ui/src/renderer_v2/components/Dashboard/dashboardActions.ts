export type DashboardActionType = 'open-host' | 'open-connections' | 'open-chat'

export interface DashboardAction {
  type: DashboardActionType
  target?: string
  label: string
}

export function matchConnectionForHost(
  host: string,
  connections: {
    ssh?: Array<{ id: string; name: string; host: string }>
    winrm?: Array<{ id: string; name: string; host: string }>
  },
): { kind: 'ssh' | 'winrm'; id: string } | null {
  const needle = host.trim().toLowerCase()
  if (!needle) return null
  const ssh = connections.ssh ?? []
  const winrm = connections.winrm ?? []
  const sshHit = ssh.find(
    (c) =>
      c.host.toLowerCase() === needle ||
      c.name.toLowerCase() === needle ||
      c.host.toLowerCase().startsWith(needle.split(':')[0]),
  )
  if (sshHit) return { kind: 'ssh', id: sshHit.id }
  const winrmHit = winrm.find(
    (c) => c.host.toLowerCase() === needle || c.name.toLowerCase() === needle,
  )
  if (winrmHit) return { kind: 'winrm', id: winrmHit.id }
  return null
}

export function filterHostsByQuery<T extends { host: string }>(
  hosts: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...hosts]
  return hosts.filter((h) => h.host.toLowerCase().includes(q))
}
