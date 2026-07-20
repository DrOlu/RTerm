import {
  resolveParams, substituteVars, maskSecrets, scrubSecrets, captureVar, checkDesiredState,
} from './runbookEngine'
import type { PlaybookParam, PlaybookStep } from '../../types'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

const P = (name: string, o: Partial<PlaybookParam> = {}): PlaybookParam => ({ name, ...o })

// --- resolveParams ---
test('resolveParams prefers supplied value over default', () => {
  const out = resolveParams([P('region', { defaultValue: 'us-east-1' })], { region: 'eu-west-1' })
  if (out.region !== 'eu-west-1') throw new Error(out.region)
})
test('resolveParams falls back to default when not supplied', () => {
  const out = resolveParams([P('region', { defaultValue: 'us-east-1' })], {})
  if (out.region !== 'us-east-1') throw new Error(out.region)
})
test('resolveParams throws for a required param with no value/default', () => {
  let threw = false
  try { resolveParams([P('token')], {}) } catch { threw = true }
  if (!threw) throw new Error('expected throw for missing required param')
})
test('resolveParams ignores empty supplied string (falls back to default)', () => {
  const out = resolveParams([P('x', { defaultValue: 'd' })], { x: '' })
  if (out.x !== 'd') throw new Error(out.x)
})

// --- substituteVars ---
test('substituteVars replaces {{name}} placeholders', () => {
  const out = substituteVars('ssh deploy@{{host}} -p {{port}}', { host: 'web-1', port: '2222' })
  if (out !== 'ssh deploy@web-1 -p 2222') throw new Error(out)
})
test('substituteVars replaces {{param.name}} form too', () => {
  const out = substituteVars('echo {{param.region}}', { region: 'us' })
  if (out !== 'echo us') throw new Error(out)
})
test('substituteVars leaves unknown placeholders untouched', () => {
  const out = substituteVars('echo {{known}} {{unknown}}', { known: 'K' })
  if (out !== 'echo K {{unknown}}') throw new Error(out)
})
test('substituteVars handles whitespace inside braces', () => {
  const out = substituteVars('echo {{ host }}', { host: 'h' })
  if (out !== 'echo h') throw new Error(out)
})

// --- maskSecrets / scrubSecrets ---
test('maskSecrets masks only secret params', () => {
  const params = [P('user'), P('password', { secret: true })]
  const out = maskSecrets(params, { user: 'admin', password: 'hunter2' })
  if (out.user !== 'admin') throw new Error('user should be visible')
  if (out.password === 'hunter2') throw new Error('password should be masked')
})
test('scrubSecrets removes secret occurrences from a blob', () => {
  const params = [P('password', { secret: true })]
  const out = scrubSecrets('connecting with hunter2 now; hunter2 again', params, { password: 'hunter2' })
  if (out.includes('hunter2')) throw new Error('secret leaked: ' + out)
})

// --- captureVar ---
test('captureVar regex extracts capture group 1', () => {
  const out = captureVar('version: 17.18.03a\nother line', 'version:\\s*(\\S+)', true)
  if (out !== '17.18.03a') throw new Error(String(out))
})
test('captureVar regex returns full match when no group', () => {
  const out = captureVar('abc123', '\\d+', true)
  if (out !== '123') throw new Error(String(out))
})
test('captureVar substring takes rest of line after pattern', () => {
  const out = captureVar('ip address 10.0.0.5\nnext', 'ip address ')
  if (out !== '10.0.0.5') throw new Error(String(out))
})
test('captureVar returns undefined when not found', () => {
  if (captureVar('nothing here', 'missing') !== undefined) throw new Error('should be undefined')
  if (captureVar('nothing', '(\\d+)', true) !== undefined) throw new Error('regex should be undefined')
})
test('captureVar invalid regex returns undefined (no crash)', () => {
  if (captureVar('x', '([', true) !== undefined) throw new Error('invalid regex should be undefined')
})

// --- checkDesiredState ---
test('checkDesiredState returns false when no desiredState declared', async () => {
  const step: PlaybookStep = { id: 'a', kind: 'command', command: 'x' }
  const r = await checkDesiredState(step, async () => ({ stdout: 'anything' }))
  if (r !== false) throw new Error('should be false')
})
test('checkDesiredState substring match -> skip (true)', async () => {
  const step: PlaybookStep = { id: 'a', kind: 'command', command: 'install', desiredState: { command: 'nginx -v', expect: 'nginx/1.25' } }
  const r = await checkDesiredState(step, async () => ({ stdout: 'nginx version: nginx/1.25.4' }))
  if (r !== true) throw new Error('should detect desired state')
})
test('checkDesiredState regex match', async () => {
  const step: PlaybookStep = { id: 'a', kind: 'command', command: 'x', desiredState: { command: 'systemctl is-active nginx', expect: '^active$', expectMode: 'regex' } }
  const r = await checkDesiredState(step, async () => ({ stdout: 'active' }))
  if (r !== true) throw new Error('regex should match')
})
test('checkDesiredState no match -> run (false)', async () => {
  const step: PlaybookStep = { id: 'a', kind: 'command', command: 'x', desiredState: { command: 'check', expect: 'present' } }
  const r = await checkDesiredState(step, async () => ({ stdout: 'absent' }))
  if (r !== false) throw new Error('should not be in desired state')
})
test('checkDesiredState check failure -> run (false, no crash)', async () => {
  const step: PlaybookStep = { id: 'a', kind: 'command', command: 'x', desiredState: { command: 'check', expect: 'present' } }
  const r = await checkDesiredState(step, async () => { throw new Error('check failed') })
  if (r !== false) throw new Error('check failure should mean not-in-desired-state')
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
