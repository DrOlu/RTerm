import { filterHostsByQuery, matchConnectionForHost } from './dashboardActions'

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`assert failed: ${msg}`)
}

assert(filterHostsByQuery([{ host: 'WEB-1' }, { host: 'db' }], 'web')[0].host === 'WEB-1', 'filter')
assert(matchConnectionForHost('10.0.0.1', { ssh: [{ id: 's1', name: 'Edge', host: '10.0.0.1' }] })?.id === 's1', 'ssh')
assert(matchConnectionForHost('WS1', { winrm: [{ id: 'w1', name: 'WS1', host: '1.2.3.4' }] })?.kind === 'winrm', 'winrm')
assert(matchConnectionForHost('', {}) === null, 'empty')
console.log('dashboardActions: all cases passed')
