import { createRequire } from 'node:module'
import validateLinuxCliRuntime from './validate-linux-cli-runtime.mjs'
import pruneLinuxPackagingRuntime from './prune-linux-packaging-runtime.mjs'
import validateBetterSqlite3Runtime from './validate-better-sqlite3-runtime.mjs'
import validateWindowsNodePtyRuntime from './validate-windows-node-pty-runtime.mjs'

const require = createRequire(import.meta.url)
const applySandboxFix = require('electron-builder-sandbox-fix')

export default async function afterPack(context) {
  await validateLinuxCliRuntime(context)
  await pruneLinuxPackagingRuntime(context)
  await validateBetterSqlite3Runtime(context)
  await validateWindowsNodePtyRuntime(context)

  if (context?.electronPlatformName === 'linux') {
    await applySandboxFix(context)
  }
}
