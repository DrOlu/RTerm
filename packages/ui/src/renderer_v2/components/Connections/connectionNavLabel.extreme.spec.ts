import { connectionNavLabel } from './connectionNavLabel'
import { CONNECTION_MANAGER_SECTIONS } from './connectionManagerRegistry'

const assert = (c: unknown, m: string): void => {
  if (!c) throw new Error(m)
}
const eq = <T>(a: T, b: T, m: string): void => {
  if (a !== b) throw new Error(`${m}: expected=${String(b)} actual=${String(a)}`)
}

const tEn = {
  connections: {
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
  },
}

console.log('PASS setup')

eq(connectionNavLabel({ labelKey: 'templates' }, tEn), 'Templates', 'templates')
eq(connectionNavLabel({ labelKey: 'triggers' }, tEn), 'Triggers', 'triggers')
eq(connectionNavLabel({ labelKey: 'playbooks' }, tEn), 'Playbooks', 'playbooks')
eq(connectionNavLabel({ labelKey: 'scheduledTasks' }, tEn), 'Scheduled Tasks', 'sched')
console.log('PASS known keys')

// The v3.3.2 bug: missing translation fell through to Templates.
eq(
  connectionNavLabel({ labelKey: 'triggers' }, { connections: { templates: 'Templates' } }),
  'Triggers',
  'triggers fallback is Triggers not Templates',
)
console.log('PASS missing translation does not steal Templates')

eq(
  connectionNavLabel({ labelKey: 'triggers' }, { connections: { triggers: '  ' } }),
  'Triggers',
  'blank translation uses fallback',
)
console.log('PASS blank translation')

const labels = CONNECTION_MANAGER_SECTIONS.map((s) => connectionNavLabel(s, tEn))
const templateCount = labels.filter((l) => l === 'Templates').length
eq(templateCount, 1, 'exactly one Templates in the nav')
assert(labels.includes('Triggers'), 'Triggers present')
assert(new Set(labels).size === labels.length, `nav labels unique: ${labels.join(',')}`)
console.log('PASS unique nav labels', labels.join(' | '))

console.log('All connectionNavLabel extreme tests passed.')
