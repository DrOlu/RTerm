import type { SkillInfo } from '../../skills/FileSkillStore'
import { BUILTIN_TOOL_INFO } from '../AgentHelper/tools'

export interface SkillStatusSummary {
  name: string
  description: string
  enabled: boolean
}

export interface BuiltInToolStatusSummary {
  name: string
  description: string
  enabled: boolean
  experimental?: boolean
}

export function buildSkillStatusSummary(
  skills: SkillInfo[],
  enabledMap: Record<string, boolean> | undefined
): SkillStatusSummary[] {
  const state = enabledMap ?? {}
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    enabled: state[skill.name] !== false
  }))
}

export function buildBuiltInToolStatusSummary(
  enabledMap: Record<string, boolean> | undefined
): BuiltInToolStatusSummary[] {
  const state = enabledMap ?? {}
  return BUILTIN_TOOL_INFO.map((tool) => ({
    name: tool.name,
    description: tool.description,
    enabled: state[tool.name] ?? tool.defaultEnabled ?? true,
    ...(tool.experimental ? { experimental: true } : {})
  }))
}

/** The settings-UI view: hides internal implementation-detail tools (write_file,
 * edit_file) that are the implementation of a user-facing capability
 * (create_or_edit). The full summary (above) includes them for the tools section. */
export function buildBuiltInToolSettingsSummary(
  enabledMap: Record<string, boolean> | undefined
): BuiltInToolStatusSummary[] {
  return buildBuiltInToolStatusSummary(enabledMap).filter(
    (tool) => !BUILTIN_TOOL_INFO.find((t) => t.name === tool.name)?.hiddenFromSettings,
  )
}
