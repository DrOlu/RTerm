import type { ConnectionManagerSectionDefinition } from './connectionManagerRegistry'

/**
 * Resolve the Connections sidebar label for a section.
 *
 * v3.3.2 bug: a nested ternary fell through to "Templates" for every
 * section after Playbooks, so Triggers rendered as a second Templates.
 */
export function connectionNavLabel(
  item: Pick<ConnectionManagerSectionDefinition, 'labelKey'>,
  t: { connections: Record<string, unknown> },
): string {
  const conn = t.connections ?? {}
  const fallback: Record<string, string> = {
    ssh: 'SSH',
    winrm: 'WinRM',
    serial: 'Serial',
    proxy: 'Proxy',
    tunnels: 'Tunnels',
    groups: 'Groups',
    scripts: 'Scripts',
    scheduledTasks: 'Scheduled Tasks',
    templates: 'Templates',
    playbooks: 'Playbooks',
    triggers: 'Triggers',
  }
  const raw = conn[item.labelKey]
  if (typeof raw === 'string' && raw.trim()) return raw
  return fallback[item.labelKey] ?? item.labelKey
}
