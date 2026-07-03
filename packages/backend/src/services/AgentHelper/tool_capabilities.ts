export const FILE_MUTATION_CAPABILITY_NAME = 'create_or_edit'
export const WRITE_FILE_TOOL_NAME = 'write_file'
export const EDIT_FILE_TOOL_NAME = 'edit_file'
export const LEGACY_CREATE_OR_EDIT_TOOL_NAME = 'create_or_edit'

export const FILE_MUTATION_TOOL_NAMES = new Set([
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  LEGACY_CREATE_OR_EDIT_TOOL_NAME
])

const BUILT_IN_TOOL_CAPABILITY_BY_MODEL_TOOL: Record<string, string> = {
  [WRITE_FILE_TOOL_NAME]: FILE_MUTATION_CAPABILITY_NAME,
  [EDIT_FILE_TOOL_NAME]: FILE_MUTATION_CAPABILITY_NAME,
  [LEGACY_CREATE_OR_EDIT_TOOL_NAME]: FILE_MUTATION_CAPABILITY_NAME
}

export function resolveBuiltInToolCapabilityName(toolName: string): string {
  return BUILT_IN_TOOL_CAPABILITY_BY_MODEL_TOOL[toolName] ?? toolName
}

export function isFileMutationToolName(toolName: string): boolean {
  return FILE_MUTATION_TOOL_NAMES.has(toolName)
}
