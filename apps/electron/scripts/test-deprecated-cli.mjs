#!/usr/bin/env node
/* eslint-disable no-console */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '../../..')

require.extensions['.ts'] = function registerTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.Node10,
    },
    fileName: filename,
  })
  module._compile(outputText, filename)
}

function fromRoot(relPath) {
  return path.join(projectRoot, relPath)
}

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeFile(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
  if (mode) fs.chmodSync(filePath, mode)
}

function readText(relPath) {
  return fs.readFileSync(fromRoot(relPath), 'utf8')
}

function testDesktopBuildDoesNotReferenceCliRuntime() {
  const rootPackage = JSON.parse(readText('package.json'))
  const scripts = rootPackage.scripts || {}
  const scriptText = JSON.stringify(scripts)
  assert.equal('prepare:cli-runtime' in scripts, false, 'root scripts must not expose prepare:cli-runtime')
  assert.equal('build:cli-binaries' in scripts, false, 'root scripts must not expose build:cli-binaries')
  assert.doesNotMatch(scriptText, /prepare:cli-runtime/, 'desktop build scripts must not prepare cli runtime')
  assert.doesNotMatch(scriptText, /build:cli-binaries/, 'desktop build scripts must not build cli binaries')

  const builderConfig = readText('apps/electron/electron-builder.yml')
  assert.doesNotMatch(builderConfig, /apps\/electron\/cli-runtime/, 'electron-builder must not bundle cli-runtime')
  assert.doesNotMatch(builderConfig, /^\s*to:\s*cli\s*$/m, 'electron-builder must not create resources/cli')

  const afterPack = readText('apps/electron/scripts/after-pack.mjs')
  assert.doesNotMatch(afterPack, /validateLinuxCliRuntime/, 'afterPack must not validate removed CLI runtime')
}

function testPosixCleanupRemovesLegacyLaunchersOnly() {
  const sandboxRoot = mkdtemp('gyshell-deprecated-cli-posix-')
  const homeDir = path.join(sandboxRoot, 'home')
  const legacyBin = path.join(homeDir, '.gyll', 'bin')
  const profilePath = path.join(homeDir, '.zshrc')
  const legacyLauncher =
    '#!/usr/bin/env bash\nGYLL_BIN="/Applications/GyShell.app/Contents/Resources/cli/bin/gyll"\nexec "$GYLL_BIN" "$@"\n'
  const unrelatedContent = '#!/usr/bin/env bash\necho keep\n'

  writeFile(path.join(legacyBin, 'gyll'), legacyLauncher, 0o755)
  writeFile(path.join(legacyBin, 'gyll-tui'), legacyLauncher, 0o755)
  writeFile(path.join(legacyBin, 'other'), unrelatedContent, 0o755)
  writeFile(profilePath, '# >>> Gyll CLI >>>\nexport PATH="$HOME/.gyll/bin:$PATH"\n# <<< Gyll CLI <<<\n')

  const { cleanupDeprecatedCliLaunchers } = require(fromRoot('packages/electron/src/main/DeprecatedCliCleanupService.ts'))
  const result = cleanupDeprecatedCliLaunchers({
    homeDir,
    platform: 'darwin',
    env: { PATH: '/usr/bin' },
    logger: { info() {}, warn() {} },
  })

  assert.equal(result.removedPaths.length, 2, 'cleanup should remove both legacy POSIX launchers')
  assert.equal(fs.existsSync(path.join(legacyBin, 'gyll')), false, 'gyll launcher should be removed')
  assert.equal(fs.existsSync(path.join(legacyBin, 'gyll-tui')), false, 'gyll-tui launcher should be removed')
  assert.equal(fs.existsSync(path.join(legacyBin, 'other')), true, 'unrelated files in .gyll/bin must be preserved')
  assert.match(fs.readFileSync(profilePath, 'utf8'), /# >>> Gyll CLI >>>/, 'shell profile PATH block must remain')
}

function testWindowsCleanupRemovesLegacyCmdLaunchersOnly() {
  const sandboxRoot = mkdtemp('gyshell-deprecated-cli-win-')
  const homeDir = path.join(sandboxRoot, 'home')
  const localAppData = path.join(sandboxRoot, 'LocalAppData')
  const windowsApps = path.join(localAppData, 'Microsoft', 'WindowsApps')
  const fallbackBin = path.join(homeDir, '.gyll', 'bin')
  const legacyCmd =
    '@echo off\r\nsetlocal\r\nset "GYLL_BIN=C:\\Program Files\\GyShell\\resources\\cli\\bin\\gyll.exe"\r\n"%GYLL_BIN%" %*\r\n'

  writeFile(path.join(windowsApps, 'gyll.cmd'), legacyCmd)
  writeFile(path.join(windowsApps, 'gyll-tui.cmd'), legacyCmd)
  writeFile(path.join(fallbackBin, 'gyll.cmd'), legacyCmd)
  writeFile(path.join(windowsApps, 'gyll-custom.cmd'), '@echo off\r\necho keep\r\n')

  const { cleanupDeprecatedCliLaunchers } = require(fromRoot('packages/electron/src/main/DeprecatedCliCleanupService.ts'))
  const result = cleanupDeprecatedCliLaunchers({
    homeDir,
    platform: 'win32',
    env: { LOCALAPPDATA: localAppData, PATH: String(windowsApps) },
    logger: { info() {}, warn() {} },
  })

  assert.equal(result.removedPaths.length, 3, 'cleanup should remove WindowsApps and fallback legacy launchers')
  assert.equal(fs.existsSync(path.join(windowsApps, 'gyll.cmd')), false, 'WindowsApps gyll.cmd should be removed')
  assert.equal(fs.existsSync(path.join(windowsApps, 'gyll-tui.cmd')), false, 'WindowsApps gyll-tui.cmd should be removed')
  assert.equal(fs.existsSync(path.join(fallbackBin, 'gyll.cmd')), false, 'fallback gyll.cmd should be removed')
  assert.equal(fs.existsSync(path.join(windowsApps, 'gyll-custom.cmd')), true, 'unrelated WindowsApps files must be preserved')
}

function run() {
  const cases = [
    ['desktop build has no CLI runtime references', testDesktopBuildDoesNotReferenceCliRuntime],
    ['POSIX cleanup removes only legacy launchers', testPosixCleanupRemovesLegacyLaunchersOnly],
    ['Windows cleanup removes only legacy cmd launchers', testWindowsCleanupRemovesLegacyCmdLaunchersOnly],
  ]

  for (const [name, fn] of cases) {
    fn()
    console.log(`PASS ${name}`)
  }
  console.log('All deprecated desktop CLI tests passed.')
}

run()
