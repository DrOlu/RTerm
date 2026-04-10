import fs from 'node:fs'
import path from 'node:path'
import {
  formatNativeBinaryIdentity,
  inspectNativeBinary,
  matchesNativeBinaryTarget,
} from './native-binary-utils.mjs'

const ARCH_BY_BUILDER_VALUE = {
  1: 'x64',
  3: 'arm64',
}

function resolveResourcesRoot(context) {
  if (context?.electronPlatformName === 'darwin') {
    const configuredProductName = context?.packager?.appInfo?.productFilename
    const preferredAppBundlePath = configuredProductName
      ? path.join(context.appOutDir, `${configuredProductName}.app`)
      : null
    const appBundlePath =
      preferredAppBundlePath && fs.existsSync(preferredAppBundlePath)
        ? preferredAppBundlePath
        : fs
            .readdirSync(context.appOutDir)
            .find((entry) => entry.endsWith('.app'))
    if (!appBundlePath) {
      throw new Error(`Unable to locate macOS app bundle in ${context.appOutDir}`)
    }
    const resolvedAppBundlePath =
      typeof appBundlePath === 'string' && appBundlePath.endsWith('.app')
        ? appBundlePath.startsWith(context.appOutDir)
          ? appBundlePath
          : path.join(context.appOutDir, appBundlePath)
        : preferredAppBundlePath
    return path.join(resolvedAppBundlePath, 'Contents', 'Resources')
  }
  return path.join(context.appOutDir, 'resources')
}

export default async function validateBetterSqlite3Runtime(context) {
  const targetPlatform = context?.electronPlatformName
  if (!targetPlatform) {
    throw new Error('Missing electron platform name in afterPack context')
  }

  const targetArch = ARCH_BY_BUILDER_VALUE[context.arch]
  if (!targetArch) {
    throw new Error(`Unsupported pack architecture for better-sqlite3 validation: ${context.arch}`)
  }

  const resourcesRoot = resolveResourcesRoot(context)
  const candidates = [
    {
      label: 'packaged fallback runtime',
      filePath: path.join(
        resourcesRoot,
        'native-modules',
        'better-sqlite3',
        'better_sqlite3.node',
      ),
    },
    {
      label: 'unpacked module runtime',
      filePath: path.join(
        resourcesRoot,
        'app.asar.unpacked',
        'node_modules',
        'better-sqlite3-electron',
        'build',
        'Release',
        'better_sqlite3.node',
      ),
    },
  ]

  candidates.forEach(({ label, filePath }) => {
    const identity = inspectNativeBinary(filePath)
    if (!matchesNativeBinaryTarget(identity, targetPlatform, targetArch)) {
      throw new Error(
        `${label} does not match ${targetPlatform}-${targetArch}: ${filePath} -> ${formatNativeBinaryIdentity(identity)}`,
      )
    }
  })
}
