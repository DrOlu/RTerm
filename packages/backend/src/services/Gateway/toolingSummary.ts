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
    enabled: state[tool.name] ?? true
  }))
}
