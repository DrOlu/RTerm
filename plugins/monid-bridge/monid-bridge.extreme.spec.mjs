import { buildMonidArgv, isLegacyBrokenArgv, resolveConfig } from './index.mjs'

const assert = (c, m) => {
  if (!c) throw new Error(`assert failed: ${m}`)
}

// --- config ---
assert(resolveConfig({ settings: {} }).enabled === true, 'enabled default')
assert(resolveConfig({ settings: { monid: { enabled: false } } }).enabled === false, 'disabled')
assert(resolveConfig({ settings: { monid: { binaryPath: '/opt/monid' } } }).binaryPath === '/opt/monid', 'bin')
assert(resolveConfig({}, { MONID_BIN: 'custom-monid' }).binaryPath === 'custom-monid', 'env bin')

// --- FP: 3.3.8 positional argv must be detected as broken ---
assert(isLegacyBrokenArgv(['discover', 'company news']) === true, 'FP discover positional')
assert(isLegacyBrokenArgv(['run', 'foo']) === true, 'FP run positional')
assert(isLegacyBrokenArgv(['discover', '--query', 'company news']) === false, 'good discover')
assert(isLegacyBrokenArgv(['run', '--provider', 'x', '--endpoint', '/y']) === false, 'good run')

const disc = buildMonidArgv('discover', { query: 'company news', limit: 5 })
assert(!isLegacyBrokenArgv(disc), 'new discover not legacy')
assert(disc[0] === 'discover' && disc[1] === '--query' && disc[2] === 'company news', `disc=${disc}`)
assert(disc.includes('--limit') && disc.includes('5') && disc.includes('--json'), 'limit+json')

assert(buildMonidArgv('version').join(' ') === '--version', 'version')
assert(buildMonidArgv('keys-list').join(' ') === 'keys list', 'keys list')
assert(buildMonidArgv('whoami').join(' ') === 'whoami', 'whoami')

const insp = buildMonidArgv('inspect', { provider: 'context.dev', endpoint: '/news/search' })
assert(insp.join(' ') === 'inspect --provider context.dev --endpoint /news/search --json', insp.join(' '))

const run = buildMonidArgv('run', {
  provider: 'context.dev',
  endpoint: '/news/search',
  input: '{"q":"acme"}',
})
assert(run[0] === 'run' && run.includes('--provider') && run.includes('context.dev'), 'run provider')
assert(run.includes('--endpoint') && run.includes('/news/search'), 'run endpoint')
assert(run.includes('--input') && run.includes('--json'), 'run input+json')
assert(!isLegacyBrokenArgv(run), 'new run not legacy')

// FN: tool="provider/endpoint" shorthand
const fromTool = buildMonidArgv('run', { tool: 'apollo/mixed_companies/search' })
assert(fromTool.includes('apollo') && fromTool.includes('/mixed_companies/search'), `fromTool=${fromTool}`)

// FN: queryParams / pathParams
const withQP = buildMonidArgv('run', {
  provider: 'akta',
  endpoint: '/v1/news',
  queryParams: '{"q":"x"}',
  pathParams: '{"id":"1"}',
})
assert(withQP.includes('--query') && withQP.includes('{"q":"x"}'), 'query flag')
assert(withQP.includes('--path') && withQP.includes('{"id":"1"}'), 'path flag')

// rejects
let threw = false
try { buildMonidArgv('discover', { query: '  ' }) } catch { threw = true }
assert(threw, 'empty query')
threw = false
try { buildMonidArgv('run', { tool: 'not-a-path' }) } catch { threw = true }
assert(threw, 'run without provider/endpoint')
threw = false
try { buildMonidArgv('run', { provider: 'x', endpoint: 'news' }) } catch { threw = true }
assert(threw, 'endpoint must start with /')
threw = false
try { buildMonidArgv('inspect', { provider: 'x' }) } catch { threw = true }
assert(threw, 'inspect needs endpoint')
threw = false
try { buildMonidArgv('nope') } catch { threw = true }
assert(threw, 'unknown sub')
threw = false
try { buildMonidArgv('discover', { query: 'q', limit: 'nope' }) } catch { threw = true }
assert(threw, 'bad limit')

console.log('monid-bridge: all cases passed')
