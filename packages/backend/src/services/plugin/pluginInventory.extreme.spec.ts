/**
 * pluginInventory.extreme.spec — every plugins/ folder must load, export
 * register(), and register exactly the tools named in plugin.json (no FP extras,
 * no FN missing tools).
 *
 * Run: npx tsx packages/backend/src/services/plugin/pluginInventory.extreme.spec.ts
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const assert = (c: unknown, m: string): void => {
  if (!c) throw new Error(`assert failed: ${m}`)
}

const root = path.resolve(process.cwd(), 'plugins')
const dirs = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

assert(dirs.length >= 10, `expected many plugins, got ${dirs.length}`)

let ok = 0
const names = new Set<string>()
for (const dirName of dirs) {
  const dir = path.join(root, dirName)
  const manPath = path.join(dir, 'plugin.json')
  assert(existsSync(manPath), `${dirName}: missing plugin.json`)
  const man = JSON.parse(readFileSync(manPath, 'utf8')) as {
    name: string
    version: string
    entry?: string
    tools?: Array<string | { name: string }>
  }
  assert(man.name && man.version, `${dirName}: name/version required`)
  assert(!names.has(man.name), `duplicate plugin name ${man.name}`)
  names.add(man.name)
  const declared = (man.tools ?? []).map((t) => (typeof t === 'string' ? t : t.name))
  const entry = path.join(dir, man.entry || 'index.mjs')
  assert(existsSync(entry), `${man.name}: missing entry ${entry}`)
  const mod = await import(pathToFileURL(entry).href)
  assert(typeof mod.register === 'function', `${man.name}: no register()`)
  const tools: string[] = []
  await mod.register({
    registerTool: (t: { name: string }) => tools.push(t.name),
    registerTrigger: () => {},
    registerPanel: () => {},
    exec: async () => ({ ok: true, stdout: '', stderr: '' }),
    runCommand: async () => ({ ok: true, stdout: '', stderr: '' }),
    readLedger: () => ({}),
    log: () => {},
    getSettings: () => ({}),
    settings: {},
  })
  const missing = declared.filter((t) => !tools.includes(t))
  const extra = tools.filter((t) => !declared.includes(t))
  assert(missing.length === 0, `${man.name} FN missing tools: ${missing}`)
  assert(extra.length === 0, `${man.name} FP extra tools: ${extra}`)
  // duplicate tool names inside one plugin
  assert(new Set(tools).size === tools.length, `${man.name} duplicate tool names`)
  ok += 1
  console.log(`PASS ${man.name} ${tools.length} tools`)
}

assert(ok === dirs.length, `loaded ${ok}/${dirs.length}`)
console.log(`pluginInventory: ${ok} plugins wired, 0 FN/FP`)
