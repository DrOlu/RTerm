#!/usr/bin/env node

// gyll/CLI TUI is deprecated and unsupported. Desktop builds no longer bundle
// this wrapper or install launchers; this file is retained only for historical
// standalone package compatibility.
const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function run(target) {
  const result = childProcess.spawnSync(target, process.argv.slice(2), {
    stdio: 'inherit',
  })
  if (result.error) {
    process.stderr.write(`Gyll CLI runtime error: ${result.error.message}\n`)
    process.exit(1)
  }
  process.exit(typeof result.status === 'number' ? result.status : 0)
}

function findBinaryInNodeModules(startDir, binaryInfo) {
  let current = startDir
  for (;;) {
    const scopedDir = path.join(current, 'node_modules', '@gyshell')
    if (fs.existsSync(scopedDir)) {
      const entries = fs.readdirSync(scopedDir)
      for (const entry of entries) {
        if (!entry.startsWith(binaryInfo.packagePrefix)) continue
        const candidate = path.join(scopedDir, entry, 'bin', binaryInfo.binaryName)
        if (fileExists(candidate)) return candidate
      }
    }

    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function resolveBinaryInfo() {
  const platformMap = {
    darwin: 'darwin',
    linux: 'linux',
    win32: 'windows',
  }
  const archMap = {
    x64: 'x64',
    arm64: 'arm64',
  }
  const platform = platformMap[os.platform()] || os.platform()
  const arch = archMap[os.arch()] || os.arch()
  return {
    packagePrefix: `tui-${platform}-${arch}`,
    binaryName: platform === 'windows' ? 'gyll.exe' : 'gyll',
  }
}

function main() {
  const fromEnv = (process.env.GYLL_BIN_PATH || '').trim()
  if (fromEnv) {
    if (!fileExists(fromEnv)) {
      process.stderr.write(`Gyll CLI runtime error: GYLL_BIN_PATH does not exist: ${fromEnv}\n`)
      process.exit(1)
    }
    run(path.resolve(fromEnv))
    return
  }

  const binaryInfo = resolveBinaryInfo()
  const resolved = findBinaryInNodeModules(__dirname, binaryInfo)
  if (!resolved) {
    process.stderr.write(
      `Unable to find platform binary package for gyll (${binaryInfo.packagePrefix}). ` +
        `Please reinstall or manually install @gyshell/${binaryInfo.packagePrefix}.\n`,
    )
    process.exit(1)
  }

  run(resolved)
}

main()
