import path from 'node:path'
import os from 'node:os'

export interface SkillScanRootOptions {
  primaryRoot: string
  homeDir?: string
  platform?: NodeJS.Platform
  appData?: string
  codexHome?: string
  /** v3.2.9: also scan compatibility roots (~/.claude/skills, ~/.codex/skills,
   * APPDATA/agents/skills, ~/.config/agents/skills). Default false — GyShell
   * v1.7.0 tightened discovery to the managed Skills folder + ~/.agents/skills
   * so skills from other tools are no longer auto-loaded. */
  includeCompatibilityRoots?: boolean
}

export function resolveDefaultSkillScanRoots(options: SkillScanRootOptions): string[] {
  const primaryRoot = path.resolve(options.primaryRoot)
  const homeDir = (options.homeDir || os.homedir() || '').trim()
  const platform = options.platform || process.platform
  const appData = (options.appData || process.env.APPDATA || '').trim()
  const codexHome = (options.codexHome || process.env.CODEX_HOME || '').trim()
  // Escape hatch: RTERM_SKILL_COMPAT_ROOTS=1 re-enables the pre-3.2.9 behavior
  // (scan ~/.claude/skills, ~/.codex/skills, config/APPDATA agents/skills too).
  const compatEnv = (process.env.RTERM_SKILL_COMPAT_ROOTS || '').trim().toLowerCase()
  const includeCompatibilityRoots =
    options.includeCompatibilityRoots === true || compatEnv === '1' || compatEnv === 'true' || compatEnv === 'yes'

  const roots: string[] = [primaryRoot]

  if (homeDir) {
    roots.push(path.join(homeDir, '.agents', 'skills'))

    // Compatibility roots (v3.2.9: opt-in only, default off).
    if (includeCompatibilityRoots) {
      roots.push(path.join(homeDir, '.claude', 'skills'))
      roots.push(path.join(homeDir, '.codex', 'skills'))

      if (platform === 'win32') {
        if (appData) {
          roots.push(path.join(appData, 'agents', 'skills'))
        }
      } else {
        roots.push(path.join(homeDir, '.config', 'agents', 'skills'))
      }
    }
  }

  if (codexHome && includeCompatibilityRoots) {
    roots.push(path.join(codexHome, 'skills'))
  }

  return [...new Set(roots.map((root) => path.resolve(root)))]
}
