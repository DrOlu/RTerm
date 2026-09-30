/**
 * sanitizeSettingsJson — the Windows portable "double-click does nothing"
 * regression spec (v3.9.5).
 *
 * Root cause (reproduced live on Windows Server 2022, RTerm portable
 * 3.9.4): electron-store's JSON.parse throws on a UTF-8 BOM. The throw
 * happens inside `new Store()` in ElectronAppSettingsMigration.run(),
 * which has no try/catch — the unhandled promise rejection kills the app
 * during startup: no window, no dialog, no Event Log entry. The BOM
 * arrives whenever an external tool rewrites the settings file (Windows
 * PowerShell 5.1's `Set-Content -Encoding UTF8` ALWAYS writes one).
 *
 * The sanitizer must: leave clean files untouched, strip a BOM from valid
 * JSON, quarantine BOM'd garbage, and never throw.
 *
 * Run:  npx tsx packages/electron/src/settings/sanitizeSettingsJson.extreme.spec.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  sanitizeSettingsJsonFile
} from './sanitizeSettingsJson'

let pass = 0
let fail = 0
const failures: string[] = []

function ok(cond: unknown, label: string, note = ''): void {
  if (cond) {
    pass++
    console.log(`PASS ${label}`)
  } else {
    fail++
    failures.push(`${label}${note ? ` — ${note}` : ''}`)
    console.log(`FAIL ${label}${note ? ` — ${note}` : ''}`)
  }
}

const withTempDir = (fn: (dir: string) => void): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-settings-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

// 1. Missing file -> no-op, no throw.
{
  withTempDir((dir) => {
    const p = path.join(dir, 'nope.json')
    const r = sanitizeSettingsJsonFile(p)
    ok(r.outcome === 'missing', 'missing file is a clean no-op')
  })
}

// 2. Clean file (no BOM) -> untouched, byte-identical.
{
  withTempDir((dir) => {
    const p = path.join(dir, 'clean.json')
    const body = Buffer.from('{"a":1}', 'utf8')
    fs.writeFileSync(p, body)
    const before = fs.readFileSync(p)
    const r = sanitizeSettingsJsonFile(p)
    ok(r.outcome === 'clean', 'clean file reports clean')
    ok(
      fs.readFileSync(p).equals(before),
      'clean file is byte-identical after sanitize (no needless rewrite)',
    )
  })
}

// 3. BOM + valid JSON -> BOM stripped, content preserved, parses.
{
  withTempDir((dir) => {
    const p = path.join(dir, 'bom.json')
    const body = Buffer.concat([BOM, Buffer.from('{"layout":{"window":{"x":-8}}}', 'utf8')])
    fs.writeFileSync(p, body)
    const r = sanitizeSettingsJsonFile(p)
    ok(r.outcome === 'bom-stripped', 'BOM file reports bom-stripped')
    const after = fs.readFileSync(p)
    ok(
      !(after.length >= 3 && after[0] === 0xef && after[1] === 0xbb && after[2] === 0xbf),
      'BOM is gone after sanitize',
    )
    ok(
      JSON.parse(after.toString('utf8')).layout.window.x === -8,
      'content preserved through the strip',
    )
  })
}

// 4. BOM + INVALID JSON (the live reproduction shape) -> quarantined.
{
  withTempDir((dir) => {
    const p = path.join(dir, 'bom-broken.json')
    fs.writeFileSync(p, Buffer.concat([BOM, Buffer.from('{"trunc', 'utf8')]))
    const r = sanitizeSettingsJsonFile(p)
    ok(r.outcome === 'quarantined-corrupt', 'BOM + garbage is quarantined')
    ok(!fs.existsSync(p), 'the corrupt file is removed so the app boots with defaults')
    ok(!!r.backupPath && fs.existsSync(r.backupPath), 'the quarantine backup exists')
    ok(
      r.backupPath?.includes('.corrupt-') === true,
      'backup carries the .corrupt- marker for support triage',
    )
  })
}

// 5. BOM-only file (BOM + empty) -> quarantined, not a crash.
{
  withTempDir((dir) => {
    const p = path.join(dir, 'bom-only.json')
    fs.writeFileSync(p, BOM)
    const r = sanitizeSettingsJsonFile(p)
    ok(r.outcome === 'quarantined-corrupt', 'BOM-only file is quarantined (empty is not valid JSON)')
  })
}

// 6. Non-JSON binary garbage WITHOUT a BOM -> untouched (out of scope:
//    the sanitizer only handles the BOM class; electron-store's own
//    try/catch path in run() covers the rest).
{
  withTempDir((dir) => {
    const p = path.join(dir, 'binary.json')
    fs.writeFileSync(p, Buffer.from([0x00, 0x01, 0x02, 0xff]))
    const r = sanitizeSettingsJsonFile(p)
    ok(r.outcome === 'clean', 'non-BOM garbage is out of the sanitizer\'s scope (reported clean)')
  })
}

// 7. Directory instead of a file -> error outcome, never a throw.
{
  withTempDir((dir) => {
    const p = path.join(dir, 'adir')
    fs.mkdirSync(p)
    let threw = false
    let r: { outcome: string } | undefined
    try {
      r = sanitizeSettingsJsonFile(p)
    } catch {
      threw = true
    }
    ok(!threw, 'sanitizer never throws (directory case)')
    ok(r?.outcome === 'error', 'directory reports error outcome')
  })
}

// 8. The exact live-repro bytes: PS 5.1 Set-Content -Encoding UTF8 on a
//    settings file whose first chars are '{\r\n'.
{
  withTempDir((dir) => {
    const p = path.join(dir, 'live-repro.json')
    // PowerShell 5.1 writes: BOM + UTF-16-style CRLF JSON body as UTF-8
    const body = Buffer.concat([BOM, Buffer.from('{\r\n    "s": 1\r\n}', 'utf8')])
    fs.writeFileSync(p, body)
    const r = sanitizeSettingsJsonFile(p)
    ok(r.outcome === 'bom-stripped', 'the live-repro file is BOM-stripped')
    ok(
      JSON.parse(fs.readFileSync(p, 'utf8')).s === 1,
      'the live-repro file parses after sanitize',
    )
  })
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log(`FAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  process.exit(1)
}
console.log('sanitizeSettingsJson: ALL TESTS PASSED')
