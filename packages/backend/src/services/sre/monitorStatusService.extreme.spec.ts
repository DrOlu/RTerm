import { MonitorStatusService } from './monitorStatusService'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

// ---- publisherWired detection ----
test('publisherWired is true when publisher is set', () => {
  const mockMonitor = { publisher: () => {}, sessions: new Map() }
  const mockTerminal = { getDisplayTerminals: () => [] }
  const svc = new MonitorStatusService(mockMonitor as any, mockTerminal as any, () => 1000)
  const r = svc.report()
  if (r.publisherWired !== true) throw new Error('should be wired')
})

test('publisherWired is false when publisher is null', () => {
  const mockMonitor = { publisher: null, sessions: new Map() }
  const mockTerminal = { getDisplayTerminals: () => [] }
  const svc = new MonitorStatusService(mockMonitor as any, mockTerminal as any, () => 1000)
  const r = svc.report()
  if (r.publisherWired !== false) throw new Error('should not be wired')
  if (!r.issues.some((i) => i.includes('publisher_not_wired'))) throw new Error('should flag publisher issue')
})

// ---- terminal status entries ----
test('reports terminal_not_connected for exited terminal', () => {
  const mockMonitor = { publisher: () => {}, sessions: new Map() }
  const mockTerminal = {
    getDisplayTerminals: () => [
      { id: 'ssh-1', state: 'exited', remoteOs: 'linux', type: 'ssh' },
    ],
  }
  const svc = new MonitorStatusService(mockMonitor as any, mockTerminal as any, () => 1000)
  const r = svc.report()
  if (r.entries.length !== 1) throw new Error('should have 1 entry')
  if (r.entries[0].connected !== false) throw new Error('should not be connected')
  if (r.entries[0].diagnosis !== 'terminal_not_connected') throw new Error(`expected terminal_not_connected, got ${r.entries[0].diagnosis}`)
})

test('reports no_monitor_session when session does not exist', () => {
  const mockMonitor = { publisher: () => {}, sessions: new Map() }
  const mockTerminal = {
    getDisplayTerminals: () => [
      { id: 'ssh-1', state: 'ready', remoteOs: 'linux', type: 'ssh' },
    ],
  }
  const svc = new MonitorStatusService(mockMonitor as any, mockTerminal as any, () => 1000)
  const r = svc.report()
  if (r.entries[0].hasSession !== false) throw new Error('should not have session')
  if (r.entries[0].diagnosis !== 'no_monitor_session') throw new Error(`expected no_monitor_session, got ${r.entries[0].diagnosis}`)
})

test('reports collection_stuck_in_flight when inFlight is true', () => {
  const mockMonitor = {
    publisher: () => {},
    sessions: new Map([['ssh-1', { inFlight: true, lastCollectAt: 500 }]]),
  }
  const mockTerminal = {
    getDisplayTerminals: () => [
      { id: 'ssh-1', state: 'ready', remoteOs: 'linux', type: 'ssh' },
    ],
  }
  const svc = new MonitorStatusService(mockMonitor as any, mockTerminal as any, () => 1000)
  const r = svc.report()
  if (r.entries[0].inFlight !== true) throw new Error('should be in flight')
  if (r.entries[0].diagnosis !== 'collection_stuck_in_flight') throw new Error(`expected collection_stuck_in_flight, got ${r.entries[0].diagnosis}`)
})

test('reports never_collected when lastCollectAt is 0', () => {
  const mockMonitor = {
    publisher: () => {},
    sessions: new Map([['ssh-1', { inFlight: false, lastCollectAt: 0 }]]),
  }
  const mockTerminal = {
    getDisplayTerminals: () => [
      { id: 'ssh-1', state: 'ready', remoteOs: 'linux', type: 'ssh' },
    ],
  }
  const svc = new MonitorStatusService(mockMonitor as any, mockTerminal as any, () => 1000)
  const r = svc.report()
  if (r.entries[0].lastCollectAt !== 0) throw new Error('should be 0')
  if (r.entries[0].diagnosis !== 'never_collected') throw new Error(`expected never_collected, got ${r.entries[0].diagnosis}`)
})

test('reports stale_collection when last collect was > 30s ago', () => {
  const mockMonitor = {
    publisher: () => {},
    sessions: new Map([['ssh-1', { inFlight: false, lastCollectAt: 500 }]]),
  }
  const mockTerminal = {
    getDisplayTerminals: () => [
      { id: 'ssh-1', state: 'ready', remoteOs: 'linux', type: 'ssh' },
    ],
  }
  const svc = new MonitorStatusService(mockMonitor as any, mockTerminal as any, () => 35000)
  const r = svc.report()
  if (!r.entries[0].diagnosis.startsWith('stale_collection')) throw new Error(`expected stale_collection, got ${r.entries[0].diagnosis}`)
})

test('reports ok when everything is healthy', () => {
  const mockMonitor = {
    publisher: () => {},
    sessions: new Map([['ssh-1', { inFlight: false, lastCollectAt: 950 }]]),
  }
  const mockTerminal = {
    getDisplayTerminals: () => [
      { id: 'ssh-1', state: 'ready', remoteOs: 'linux', type: 'ssh' },
    ],
  }
  const svc = new MonitorStatusService(mockMonitor as any, mockTerminal as any, () => 1000)
  const r = svc.report()
  if (r.entries[0].diagnosis !== 'ok') throw new Error(`expected ok, got ${r.entries[0].diagnosis}`)
  if (r.issues.length !== 0) throw new Error(`expected 0 issues, got ${r.issues.length}`)
})

test('reports no_terminals when no terminals connected', () => {
  const mockMonitor = { publisher: () => {}, sessions: new Map() }
  const mockTerminal = { getDisplayTerminals: () => [] }
  const svc = new MonitorStatusService(mockMonitor as any, mockTerminal as any, () => 1000)
  const r = svc.report()
  if (r.terminalCount !== 0) throw new Error('should be 0')
  if (!r.issues.some((i) => i.includes('no_terminals'))) throw new Error('should flag no terminals')
})

// ---- summary ----
test('summary includes publisher status and terminal count', () => {
  const mockMonitor = { publisher: () => {}, sessions: new Map() }
  const mockTerminal = {
    getDisplayTerminals: () => [
      { id: 'ssh-1', state: 'ready', remoteOs: 'linux', type: 'ssh' },
    ],
  }
  const svc = new MonitorStatusService(mockMonitor as any, mockTerminal as any, () => 1000)
  const s = svc.summary()
  if (!s.includes('publisher=wired')) throw new Error('should include publisher')
  if (!s.includes('terminals=1')) throw new Error('should include terminal count')
})

test('summary lists issues when present', () => {
  const mockMonitor = { publisher: null, sessions: new Map() }
  const mockTerminal = { getDisplayTerminals: () => [] }
  const svc = new MonitorStatusService(mockMonitor as any, mockTerminal as any, () => 1000)
  const s = svc.summary()
  if (!s.includes('NOT WIRED')) throw new Error('should include NOT WIRED')
  if (!s.includes('publisher_not_wired')) throw new Error('should include publisher_not_wired')
})

test('summary says all normal when healthy', () => {
  const mockMonitor = {
    publisher: () => {},
    sessions: new Map([['ssh-1', { inFlight: false, lastCollectAt: 950 }]]),
  }
  const mockTerminal = {
    getDisplayTerminals: () => [
      { id: 'ssh-1', state: 'ready', remoteOs: 'linux', type: 'ssh' },
    ],
  }
  const svc = new MonitorStatusService(mockMonitor as any, mockTerminal as any, () => 1000)
  const s = svc.summary()
  if (!s.includes('all terminals collecting normally')) throw new Error('should say all normal')
})

async function main() {
  let pass = 0, fail = 0
  for (const c of cases) {
    try { await c.run(); pass++; console.log(`PASS ${c.name}`) }
    catch (e: any) { fail++; console.log(`FAIL ${c.name}: ${e?.message ?? e}`) }
  }
  console.log(`\n${pass}/${cases.length} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
void main()
