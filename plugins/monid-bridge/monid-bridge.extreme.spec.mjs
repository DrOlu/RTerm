import { buildMonidArgv, resolveConfig } from './index.mjs'

const assert = (c, m) => {
  if (!c) throw new Error(`assert failed: ${m}`)
}

assert(resolveConfig({ settings: {} }).enabled === true, 'enabled default')
assert(resolveConfig({ settings: { monid: { enabled: false } } }).enabled === false, 'disabled')
assert(resolveConfig({ settings: { monid: { binaryPath: '/opt/monid' } } }).binaryPath === '/opt/monid', 'bin')
assert(resolveConfig({}, { MONID_BIN: 'custom-monid' }).binaryPath === 'custom-monid', 'env bin')

assert(buildMonidArgv('version').join(' ') === '--version', 'version')
assert(buildMonidArgv('keys-list').join(' ') === 'keys list', 'keys list')
assert(buildMonidArgv('discover', { query: 'company news' }).join(' ') === 'discover company news', 'discover')
assert(buildMonidArgv('run', { tool: 'foo', input: '{"a":1}' }).join(' ') === 'run foo --input {"a":1}', 'run')

let threw = false
try { buildMonidArgv('discover', { query: '' }) } catch { threw = true }
assert(threw, 'discover requires query')
threw = false
try { buildMonidArgv('run', {}) } catch { threw = true }
assert(threw, 'run requires tool')
threw = false
try { buildMonidArgv('nope') } catch { threw = true }
assert(threw, 'unknown sub')

console.log('monid-bridge: all cases passed')
