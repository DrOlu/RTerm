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

export interface PluginToolStatusSummary {
  name: string
  description: string
  plugin: string
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
  // User request: show ALL tools in Settings, including write_file / edit_file.
  return buildBuiltInToolStatusSummary(enabledMap)
}

export function buildPluginToolStatusSummary(
  tools: Array<{ name: string; description?: string; plugin: string }>,
  enabledMap?: Record<string, boolean>,
): PluginToolStatusSummary[] {
  const state = enabledMap ?? {}
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description || tool.name,
    plugin: tool.plugin,
    enabled: state[tool.name] !== false,
  }))
}
