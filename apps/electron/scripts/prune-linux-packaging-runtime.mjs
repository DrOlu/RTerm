import fs from 'node:fs/promises'
import path from 'node:path'

const ARCH_BY_BUILDER_VALUE = {
  1: 'x64',
  3: 'arm64',
}

const BETTER_SQLITE3_MODULE_NAMES = ['better-sqlite3', 'better-sqlite3-electron']

const BETTER_SQLITE3_PRUNE_PATHS = [
  'README.md',
  'binding.gyp',
  'bin',
  'deps',
  'src',
  'build/deps',
  'build/Makefile',
  'build/better_sqlite3.target.mk',
  'build/binding.Makefile',
  'build/config.gypi',
  'build/gyp-mac-tool',
  'build/test_extension.target.mk',
  'build/Release/test_extension.node',
]

const NODE_PTY_PRUNE_PATHS = ['build', 'deps', 'scripts', 'src']

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function removeIfPresent(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true })
}

async function pruneBetterSqlite3Module(nodeModulesRoot, moduleName) {
  const moduleRoot = path.join(nodeModulesRoot, moduleName)
  if (!(await pathExists(moduleRoot))) {
    return
  }

  await Promise.all(
    BETTER_SQLITE3_PRUNE_PATHS.map((relativePath) => removeIfPresent(path.join(moduleRoot, relativePath))),
  )
}

async function pruneNodePtyModule(nodeModulesRoot, arch) {
  const moduleRoot = path.join(nodeModulesRoot, 'node-pty')
  if (!(await pathExists(moduleRoot))) {
    return
  }

  await Promise.all(NODE_PTY_PRUNE_PATHS.map((relativePath) => removeIfPresent(path.join(moduleRoot, relativePath))))

  const prebuildsRoot = path.join(moduleRoot, 'prebuilds')
  if (!(await pathExists(prebuildsRoot))) {
    return
  }

  const targetPrebuild = `linux-${arch}`
  const prebuildEntries = await fs.readdir(prebuildsRoot, { withFileTypes: true })
  await Promise.all(
    prebuildEntries
      .filter((entry) => entry.isDirectory() && entry.name !== targetPrebuild)
      .map((entry) => removeIfPresent(path.join(prebuildsRoot, entry.name))),
  )
}

export default async function pruneLinuxPackagingRuntime(context) {
  if (context?.electronPlatformName !== 'linux') {
    return
  }

  const arch = ARCH_BY_BUILDER_VALUE[context.arch]
  if (!arch) {
    throw new Error(`Unsupported Linux pack architecture for unpacked runtime pruning: ${context.arch}`)
  }

  const nodeModulesRoot = path.join(context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules')
  if (!(await pathExists(nodeModulesRoot))) {
    return
  }

  // Homebrew rpmbuild on macOS crashes on executable .gyp files inside unpacked
  // native modules. Keep only the runtime files the packaged app actually needs.
  await Promise.all(BETTER_SQLITE3_MODULE_NAMES.map((moduleName) => pruneBetterSqlite3Module(nodeModulesRoot, moduleName)))
  await pruneNodePtyModule(nodeModulesRoot, arch)
}
