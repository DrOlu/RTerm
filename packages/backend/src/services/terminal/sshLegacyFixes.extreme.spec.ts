import { normalizePersistedTerminalConfig } from './terminalConnectionSupport'

/**
 * sshLegacyFixes.extreme.spec — v3.0.6 legacy-SSH fixes:
 *  - algorithmsPreset survives persistence/reconnect (the SFTP "Not connected" bug)
 *  - readyTimeout override is honoured
 * Run: npx tsx --test packages/backend/src/services/terminal/sshLegacyFixes.extreme.spec.ts
 */

const assert = (c: unknown, m: string): void => {
  if (!c) throw new Error(`assert failed: ${m}`)
}
const runCase = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const baseSsh = {
  type: 'ssh',
  id: 'ssh-1',
  title: 'Cisco',
  cols: 80,
  rows: 24,
  host: '3.95.72.240',
  port: 22,
  username: 'admin',
  authMethod: 'password',
  password: 'x',
}

await runCase('algorithmsPreset=cisco survives persistence (SFTP bug fix)', () => {
  const out = normalizePersistedTerminalConfig({ ...baseSsh, algorithmsPreset: 'cisco' }) as Record<string, unknown>
  assert(out?.algorithmsPreset === 'cisco', `cisco preset dropped: ${JSON.stringify(out?.algorithmsPreset)}`)
})

await runCase('algorithmsPreset=legacy survives persistence', () => {
  const out = normalizePersistedTerminalConfig({ ...baseSsh, algorithmsPreset: 'legacy' }) as Record<string, unknown>
  assert(out?.algorithmsPreset === 'legacy', 'legacy preset dropped')
})

await runCase('algorithmsPreset=modern survives persistence', () => {
  const out = normalizePersistedTerminalConfig({ ...baseSsh, algorithmsPreset: 'modern' }) as Record<string, unknown>
  assert(out?.algorithmsPreset === 'modern', 'modern preset dropped')
})

await runCase('missing/invalid preset is omitted (not defaulted wrongly)', () => {
  const out = normalizePersistedTerminalConfig({ ...baseSsh }) as Record<string, unknown>
  assert(out?.algorithmsPreset === undefined, 'absent preset must stay absent (modern default)')
  const bad = normalizePersistedTerminalConfig({ ...baseSsh, algorithmsPreset: 'bogus' }) as Record<string, unknown>
  assert(bad?.algorithmsPreset === undefined, 'invalid preset must be omitted')
})

await runCase('readyTimeout survives persistence (slow-negotiation override)', () => {
  const out = normalizePersistedTerminalConfig({ ...baseSsh, algorithmsPreset: 'cisco', readyTimeout: 120000 }) as Record<string, unknown>
  assert(out?.algorithmsPreset === 'cisco', 'preset kept')
  // readyTimeout is a runtime field; persistence must not strip a valid number.
  assert(out?.readyTimeout === 120000, `readyTimeout dropped: ${out?.readyTimeout}`)
})

console.log('sshLegacyFixes: all cases passed')
