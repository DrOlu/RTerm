/**
 * applyMonidApiKey — persist a Monid API key via the official CLI
 * (`monid keys add -k … -l …`) so RTerm never stores the secret in settings.json.
 *
 * spawnSync is injectable for tests.
 */
import { spawnSync } from 'node:child_process'

export interface ApplyMonidApiKeyInput {
  apiKey: string
  binaryPath?: string
  keyLabel?: string
}

export interface ApplyMonidApiKeyResult {
  ok: boolean
  argv: string[]
  stdout: string
  stderr: string
  error?: string
}

export function buildMonidKeysAddArgv(input: ApplyMonidApiKeyInput): string[] {
  const bin = (input.binaryPath || 'monid').trim() || 'monid'
  const label = (input.keyLabel || 'rterm').trim() || 'rterm'
  return [bin, 'keys', 'add', '-k', input.apiKey, '-l', label]
}

export function applyMonidApiKey(
  input: ApplyMonidApiKeyInput,
  spawn: typeof spawnSync = spawnSync,
): ApplyMonidApiKeyResult {
  const key = String(input.apiKey || '').trim()
  if (!key) {
    return { ok: false, argv: [], stdout: '', stderr: '', error: 'empty api key' }
  }
  const argv = buildMonidKeysAddArgv({ ...input, apiKey: key })
  const [cmd, ...args] = argv
  try {
    const r = spawn(cmd, args, { encoding: 'utf8', timeout: 20000 })
    const stdout = String(r.stdout ?? '')
    const stderr = String(r.stderr ?? '')
    if (r.error) {
      return { ok: false, argv, stdout, stderr, error: r.error.message }
    }
    if (typeof r.status === 'number' && r.status !== 0) {
      return { ok: false, argv, stdout, stderr, error: stderr.trim() || `exit ${r.status}` }
    }
    return { ok: true, argv, stdout, stderr }
  } catch (e) {
    return {
      ok: false,
      argv,
      stdout: '',
      stderr: '',
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
