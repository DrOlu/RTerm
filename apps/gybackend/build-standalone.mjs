#!/usr/bin/env node
/**
 * Build the standalone gybackend CLI.
 *
 * Emits dist-standalone/gybackend.js — a near-single-file ESM bundle that
 * inlines @gyshell/shared and every pure-JS dependency.
 *
 * Why ESM (not CJS): the backend's betterSqlite3Runtime.ts legitimately uses
 * `createRequire(import.meta.url)`, which is undefined in CJS output — so CJS
 * bundling breaks. ESM output is required. Bundled CJS packages (ws, socks,
 * ssh2 JS parts, …) that call bare `require(...)` are handled by the
 * collision-free CJS-globals banner below (assigned onto globalThis, using
 * uniquely-named module-scope helpers so it never redeclares `createRequire`,
 * which app modules import themselves).
 *
 * Only packages that ship native binaries or load wasm/binary assets at runtime
 * are left external (resolved from node_modules at runtime):
 *   better-sqlite3 / better-sqlite3-electron  (compiled .node)
 *   node-pty                                  (compiled .node + spawn helper)
 *   serialport                                (compiled .node; lazily required, optional)
 *   ssh2 / cpu-features                       (sshcrypto.node / cpufeatures.node)
 *   web-tree-sitter, tree-sitter-bash         (.wasm via require.resolve)
 *
 * Everything else (@gyshell/shared, langchain, MCP SDK, socks, ws, zod, uuid,
 * diff, remeda, @xterm/headless, electron-store, …) is bundled in.
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')

const EXTERNAL = [
  'better-sqlite3',
  'better-sqlite3-electron',
  'node-pty',
  'serialport',
  'ssh2',
  'cpu-features',
  'web-tree-sitter',
  'tree-sitter-bash',
  // Any .node/.wasm asset reference stays external (never inlined).
  '*.node',
  '*.wasm',
]

// Collision-free CJS-globals shim. Assigns require/__filename/__dirname onto
// globalThis using uniquely-named module-scope imports, so bundled CJS deps can
// call require(...) without redeclaring names app modules import (createRequire).
// For CJS output: the shim uses `var` + `require` (CJS-native, no ESM import).
const banner = `#!/usr/bin/env node
// gybackend — RTerm headless backend CLI (standalone CJS build).
// Bundled by apps/gybackend/build-standalone.mjs. Do not edit by hand.
// CJS-globals shim: give bundled CJS deps a require() they can call.
var __gybCR = require('module').createRequire(__filename)
globalThis.__gybRequire = __gybCR`

const outfile = path.join(here, 'dist-standalone', 'gybackend.js')
fs.mkdirSync(path.dirname(outfile), { recursive: true })

await build({
  entryPoints: [path.join(here, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node18'],
  outfile,
  banner: { js: banner },
  alias: {
    '@gyshell/shared': path.join(repoRoot, 'packages/shared/src/index.ts'),
  },
  external: EXTERNAL,
  mainFields: ['module', 'main'],
  logLevel: 'info',
})

try { fs.chmodSync(outfile, 0o755) } catch {}

const sizeKb = (fs.statSync(outfile).size / 1024).toFixed(0)
console.log(`[build-standalone] wrote ${outfile} (${sizeKb} KB)`)
