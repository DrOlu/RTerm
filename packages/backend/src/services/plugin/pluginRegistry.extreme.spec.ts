import { PluginRegistry, type PluginManifest, type PluginModule, type PluginRecord } from './pluginRegistry'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

let T = 1_000_000
const now = () => T

function mkManifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return { name: 'test-plugin', version: '1.0.0', description: 'test', ...over }
}

function mkRegistry(createCtx?: (p: PluginRecord) => any, loadModule?: (e: string) => Promise<PluginModule>) {
  const logs: string[] = []
  const registry = new PluginRegistry({
    scanRoots: [],
    createContext: createCtx ?? ((rec) => PluginRegistry.defaultContext(rec, async () => 'out', () => ({}), (l) => logs.push(l))),
    loadModule,
    now,
    onLog: (l) => logs.push(l),
  })
  return { registry, logs }
}

async function withPluginDir(files: Record<string, string>, fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rterm-plugin-test-'))
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content)
  }
  try {
    await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('loadFromDir: loads a valid plugin and calls register(ctx)', async () => {
  let registered = false
  const { registry } = mkRegistry(undefined, async () => ({ register: () => { registered = true } }))
  await withPluginDir({ 'plugin.json': JSON.stringify(mkManifest()), 'index.js': 'export {}' }, async (dir) => {
    const rec = await registry.loadFromDir(dir)
    if (!rec) throw new Error('plugin not loaded')
    if (!registered) throw new Error('register not called')
    if (rec.manifest.name !== 'test-plugin') throw new Error('manifest')
    if (!rec.loadedAt) throw new Error('loadedAt not set')
  })
})

test('loadFromDir: plugin registers tools, triggers, panels into the record', async () => {
  const { registry } = mkRegistry(undefined, async () => ({
    register: (ctx) => {
      ctx.registerTool({ name: 'my_tool', description: 'a tool', handler: () => 'ok' })
      ctx.registerTrigger({ name: 'my_trigger', kind: 'pattern', match: 'ERR', action: 'alert' })
      ctx.registerPanel('my-panel', () => '<div>panel</div>')
    },
  }))
  await withPluginDir({ 'plugin.json': JSON.stringify(mkManifest()), 'index.js': 'export {}' }, async (dir) => {
    const rec = await registry.loadFromDir(dir)!
    if (rec!.tools.length !== 1 || rec!.tools[0].name !== 'my_tool') throw new Error('tool not registered')
    if (rec!.triggers.length !== 1 || rec!.triggers[0].name !== 'my_trigger') throw new Error('trigger not registered')
    if (rec!.panels.length !== 1 || rec!.panels[0].name !== 'my-panel') throw new Error('panel not registered')
  })
})

test('loadFromDir: returns undefined when plugin.json is missing', async () => {
  const { registry } = mkRegistry()
  await withPluginDir({ 'index.js': 'export {}' }, async (dir) => {
    const rec = await registry.loadFromDir(dir)
    if (rec !== undefined) throw new Error('should return undefined without plugin.json')
  })
})

test('loadFromDir: returns undefined when plugin.json is invalid JSON', async () => {
  const { registry } = mkRegistry()
  await withPluginDir({ 'plugin.json': 'not json{', 'index.js': 'export {}' }, async (dir) => {
    const rec = await registry.loadFromDir(dir)
    if (rec !== undefined) throw new Error('should return undefined for invalid json')
  })
})

test('loadFromDir: returns undefined when plugin.json missing name/version', async () => {
  const { registry } = mkRegistry()
  await withPluginDir({ 'plugin.json': JSON.stringify({ name: 'x' }), 'index.js': 'export {}' }, async (dir) => {
    const rec = await registry.loadFromDir(dir)
    if (rec !== undefined) throw new Error('should return undefined without version')
  })
})

test('loadFromDir: records an error when no entry module exists', async () => {
  const { registry } = mkRegistry()
  await withPluginDir({ 'plugin.json': JSON.stringify(mkManifest()) }, async (dir) => {
    const rec = await registry.loadFromDir(dir)!
    if (!rec!.error || !rec!.error.includes('no entry module')) throw new Error(`expected entry-module error, got ${rec!.error}`)
  })
})

test('loadFromDir: records an error when the entry module does not export register', async () => {
  const { registry } = mkRegistry(undefined, async () => ({ notRegister: () => {} } as any))
  await withPluginDir({ 'plugin.json': JSON.stringify(mkManifest()), 'index.js': 'export {}' }, async (dir) => {
    const rec = await registry.loadFromDir(dir)!
    if (!rec!.error || !rec!.error.includes('register')) throw new Error(`expected register error, got ${rec!.error}`)
  })
})

test('loadFromDir: records an error when register() throws', async () => {
  const { registry } = mkRegistry(undefined, async () => ({ register: () => { throw new Error('boom') } }))
  await withPluginDir({ 'plugin.json': JSON.stringify(mkManifest()), 'index.js': 'export {}' }, async (dir) => {
    const rec = await registry.loadFromDir(dir)!
    if (rec!.error !== 'boom') throw new Error(`expected boom, got ${rec!.error}`)
  })
})

test('loadFromDir: manifest.entry overrides the default entry resolution', async () => {
  let loaded = false
  const { registry } = mkRegistry(undefined, async (entryPath) => {
    if (entryPath.endsWith('custom.ts')) loaded = true
    return { register: () => {} }
  })
  await withPluginDir({ 'plugin.json': JSON.stringify(mkManifest({ entry: 'custom.ts' })), 'custom.ts': 'export {}', 'index.js': 'export {}' }, async (dir) => {
    await registry.loadFromDir(dir)
    if (!loaded) throw new Error('manifest.entry not honored')
  })
})

test('reload: discovers multiple plugins in a scan root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rterm-plugins-root-'))
  await fs.mkdir(path.join(root, 'plugin-a'))
  await fs.mkdir(path.join(root, 'plugin-b'))
  await fs.writeFile(path.join(root, 'plugin-a', 'plugin.json'), JSON.stringify(mkManifest({ name: 'plugin-a', version: '1.0.0' })))
  await fs.writeFile(path.join(root, 'plugin-a', 'index.js'), 'export {}')
  await fs.writeFile(path.join(root, 'plugin-b', 'plugin.json'), JSON.stringify(mkManifest({ name: 'plugin-b', version: '1.0.0' })))
  await fs.writeFile(path.join(root, 'plugin-b', 'index.js'), 'export {}')
  try {
    const registry = new PluginRegistry({
      scanRoots: [root],
      createContext: (rec) => PluginRegistry.defaultContext(rec, async () => 'out', () => ({}), () => {}),
      loadModule: async () => ({ register: () => {} }),
      now,
    })
    const recs = await registry.reload()
    if (recs.length !== 2) throw new Error(`expected 2 plugins, got ${recs.length}`)
    const names = recs.map((r) => r.manifest.name).sort().join(',')
    if (names !== 'plugin-a,plugin-b') throw new Error(`names ${names}`)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('reload: skips non-directory entries and hidden folders', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rterm-plugins-root-'))
  await fs.writeFile(path.join(root, 'afile.txt'), 'not a dir')
  await fs.mkdir(path.join(root, '.hidden'))
  await fs.mkdir(path.join(root, 'plugin-a'))
  await fs.writeFile(path.join(root, 'plugin-a', 'plugin.json'), JSON.stringify(mkManifest({ name: 'plugin-a', version: '1.0.0' })))
  await fs.writeFile(path.join(root, 'plugin-a', 'index.js'), 'export {}')
  try {
    const registry = new PluginRegistry({
      scanRoots: [root],
      createContext: (rec) => PluginRegistry.defaultContext(rec, async () => 'out', () => ({}), () => {}),
      loadModule: async () => ({ register: () => {} }),
      now,
    })
    const recs = await registry.reload()
    if (recs.length !== 1) throw new Error(`expected 1 plugin, got ${recs.length}`)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('setEnabled: disabled plugins are excluded from allTools/allTriggers/allPanels', async () => {
  const { registry } = mkRegistry(undefined, async () => ({
    register: (ctx) => {
      ctx.registerTool({ name: 't', description: 't', handler: () => 'x' })
      ctx.registerTrigger({ name: 'tr', kind: 'pattern', match: 'x', action: 'a' })
      ctx.registerPanel('p', () => 'x')
    },
  }))
  await withPluginDir({ 'plugin.json': JSON.stringify(mkManifest()), 'index.js': 'export {}' }, async (dir) => {
    const rec = await registry.loadFromDir(dir)!
    if (registry.allTools().length !== 1) throw new Error('tool should be present')
    registry.setEnabled(rec!.id, false)
    if (registry.allTools().length !== 0) throw new Error('disabled plugin tool should be excluded')
    if (registry.allTriggers().length !== 0) throw new Error('disabled trigger excluded')
    if (registry.allPanels().length !== 0) throw new Error('disabled panel excluded')
    registry.setEnabled(rec!.id, true)
    if (registry.allTools().length !== 1) throw new Error('re-enabled tool should be back')
  })
})

test('uninstall: removes the plugin and its capabilities', async () => {
  const { registry } = mkRegistry(undefined, async () => ({ register: (ctx) => ctx.registerTool({ name: 't', description: 't', handler: () => 'x' }) }))
  await withPluginDir({ 'plugin.json': JSON.stringify(mkManifest()), 'index.js': 'export {}' }, async (dir) => {
    const rec = await registry.loadFromDir(dir)!
    if (!registry.uninstall(rec!.id)) throw new Error('uninstall returned false')
    if (registry.get(rec!.id)) throw new Error('plugin should be gone')
    if (registry.allTools().length !== 0) throw new Error('capabilities should be gone')
  })
})

test('get: looks up by id or name (case-insensitive)', async () => {
  const { registry } = mkRegistry(undefined, async () => ({ register: () => {} }))
  await withPluginDir({ 'plugin.json': JSON.stringify(mkManifest({ name: 'My-Plugin', version: '1.0.0' })), 'index.js': 'export {}' }, async (dir) => {
    const rec = await registry.loadFromDir(dir)!
    if (!registry.get(rec!.id)) throw new Error('get by id')
    if (!registry.get('my-plugin')) throw new Error('get by name (lowercase)')
    if (!registry.get('MY-PLUGIN')) throw new Error('get by name (uppercase)')
  })
})

test('error plugins (failed load) are excluded from capability lists but kept in the registry', async () => {
  const { registry } = mkRegistry(undefined, async () => { throw new Error('load fail') })
  await withPluginDir({ 'plugin.json': JSON.stringify(mkManifest()), 'index.js': 'export {}' }, async (dir) => {
    const rec = await registry.loadFromDir(dir)!
    if (!rec!.error) throw new Error('should record error')
    if (registry.allTools().length !== 0) throw new Error('error plugin tool should be excluded')
    if (registry.list().length !== 1) throw new Error('error plugin should stay in registry')
  })
})

test('reloading the same plugin name replaces the previous record (dedupe)', async () => {
  const { registry } = mkRegistry(undefined, async () => ({ register: () => {} }))
  await withPluginDir({ 'plugin.json': JSON.stringify(mkManifest()), 'index.js': 'export {}' }, async (dir) => {
    const first = await registry.loadFromDir(dir)!
    const second = await registry.loadFromDir(dir)!
    if (registry.list().length !== 1) throw new Error('should dedupe by name')
    if (first!.id === second!.id) throw new Error('should be a new record id')
  })
})

test('PluginRegistry.defaultContext registers into the record lists and delegates exec/readLedger/log', async () => {
  const rec = { tools: [], triggers: [], panels: [] } as any
  const calls: string[] = []
  const ctx = PluginRegistry.defaultContext(rec, async (cmd) => { calls.push(`exec:${cmd}`); return 'out' }, (name) => ({ name }), (l) => calls.push(`log:${l}`))
  ctx.registerTool({ name: 't', description: 't', handler: () => 'x' })
  ctx.registerTrigger({ name: 'tr', kind: 'pattern', match: 'x', action: 'a' })
  ctx.registerPanel('p', () => 'x')
  await ctx.exec('ls')
  ctx.readLedger('metrics')
  ctx.log('hello')
  if (rec.tools.length !== 1 || rec.triggers.length !== 1 || rec.panels.length !== 1) throw new Error('context registration failed')
  if (!calls.includes('exec:ls') || !calls.includes('log:hello')) throw new Error('delegation failed')
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
