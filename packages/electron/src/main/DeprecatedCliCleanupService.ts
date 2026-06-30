import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LEGACY_LAUNCHER_MARKER = 'GYLL_BIN'
const LEGACY_POSIX_LAUNCHERS = ['gyll', 'gyll-tui']
const LEGACY_WINDOWS_LAUNCHERS = ['gyll.cmd', 'gyll-tui.cmd']

type Logger = Pick<Console, 'info' | 'warn'>

export interface DeprecatedCliCleanupOptions {
  homeDir?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  logger?: Logger
}

export interface DeprecatedCliCleanupResult {
  removedPaths: string[]
}

// gyll/CLI TUI is deprecated and unsupported. The desktop app no longer
// installs shell launchers; this cleanup only removes launchers created by
// previous desktop versions and intentionally leaves shell profile PATH blocks.
export function cleanupDeprecatedCliLaunchers(options: DeprecatedCliCleanupOptions = {}): DeprecatedCliCleanupResult {
  const logger = options.logger ?? console
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? os.homedir()
  const env = options.env ?? process.env
  const removedPaths: string[] = []

  for (const launcherPath of resolveLegacyLauncherPaths(platform, homeDir, env)) {
    if (!isLegacyLauncherFile(launcherPath, logger)) continue
    try {
      fs.rmSync(launcherPath, { force: true })
      removedPaths.push(launcherPath)
    } catch (error) {
      logger.warn(`[CLI] Failed to remove deprecated gyll launcher: ${launcherPath}`, error)
    }
  }

  removeEmptyLegacyBinDirs(homeDir, logger)

  if (removedPaths.length > 0) {
    logger.info(`[CLI] Removed deprecated gyll launchers: ${removedPaths.join(', ')}`)
  }
  return { removedPaths }
}

function resolveLegacyLauncherPaths(platform: NodeJS.Platform, homeDir: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    return resolveWindowsLegacyBinDirs(homeDir, env).flatMap((binDir) =>
      LEGACY_WINDOWS_LAUNCHERS.map((fileName) => path.join(binDir, fileName)),
    )
  }

  const binDir = path.join(homeDir, '.gyll', 'bin')
  return LEGACY_POSIX_LAUNCHERS.map((fileName) => path.join(binDir, fileName))
}

function resolveWindowsLegacyBinDirs(homeDir: string, env: NodeJS.ProcessEnv): string[] {
  const dirs = [path.join(homeDir, '.gyll', 'bin')]
  const localAppData = (env.LOCALAPPDATA || '').trim()
  if (localAppData) {
    dirs.unshift(path.join(localAppData, 'Microsoft', 'WindowsApps'))
  }
  return [...new Set(dirs)]
}

function isLegacyLauncherFile(filePath: string, logger: Logger): boolean {
  if (!isFile(filePath)) return false
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    return content.includes(LEGACY_LAUNCHER_MARKER)
  } catch (error) {
    logger.warn(`[CLI] Unable to inspect deprecated gyll launcher: ${filePath}`, error)
    return false
  }
}

function removeEmptyLegacyBinDirs(homeDir: string, logger: Logger): void {
  const dirs = [path.join(homeDir, '.gyll', 'bin')]
  for (const dir of dirs) {
    removeDirectoryIfEmpty(dir, logger)
  }
  removeDirectoryIfEmpty(path.join(homeDir, '.gyll'), logger)
}

function removeDirectoryIfEmpty(dirPath: string, logger: Logger): void {
  try {
    fs.rmdirSync(dirPath)
  } catch (error) {
    if (isExpectedRmdirFailure(error)) return
    logger.warn(`[CLI] Failed to remove empty deprecated gyll directory: ${dirPath}`, error)
  }
}

function isExpectedRmdirFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST'
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}
