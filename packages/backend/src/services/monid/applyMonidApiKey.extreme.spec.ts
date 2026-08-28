import { applyMonidApiKey, buildMonidKeysAddArgv } from './applyMonidApiKey'
import { normalizeMonidSettings } from '../settings/migrations'

const assert = (c: unknown, m: string): void => {
  if (!c) throw new Error(`assert failed: ${m}`)
}

assert(
  buildMonidKeysAddArgv({ apiKey: 'sk-test' }).join(' ') === 'monid keys add -k sk-test -l rterm',
  'default bin+label',
)
assert(
  buildMonidKeysAddArgv({ apiKey: 'abc', binaryPath: '/opt/monid', keyLabel: 'prod' }).join(' ') ===
    '/opt/monid keys add -k abc -l prod',
  'custom bin+label',
)

const empty = applyMonidApiKey({ apiKey: '  ' })
assert(empty.ok === false && empty.error === 'empty api key', 'empty key')

let spawned: { cmd: string; args: string[] } | undefined
const fakeSpawn = ((cmd: string, args: string[]) => {
  spawned = { cmd, args }
  return { status: 0, stdout: 'ok', stderr: '', error: undefined }
}) as never
const ok = applyMonidApiKey({ apiKey: 'sekrit', keyLabel: 'rterm' }, fakeSpawn)
assert(ok.ok === true, 'spawn ok')
assert(spawned?.cmd === 'monid' && spawned?.args.includes('sekrit'), 'spawned with key')
assert(spawned?.args.includes('-l') && spawned?.args.includes('rterm'), 'label rterm')

const stripped = normalizeMonidSettings({
  enabled: true,
  binaryPath: 'monid',
  apiKey: 'MUST-NOT-PERSIST',
  keyLabel: 'rterm',
})
assert(!('apiKey' in stripped), `apiKey leaked: ${JSON.stringify(stripped)}`)
assert(stripped.enabled === true && stripped.keyLabel === 'rterm', 'other fields kept')

const disabled = normalizeMonidSettings({ enabled: false, apiKey: 'x' })
assert(disabled.enabled === false && !('apiKey' in disabled), 'disabled still strips key')

console.log('applyMonidApiKey: all cases passed')
