import { ChatOpenAI } from '@langchain/openai'
import type { BackendSettings, ModelDefinition, ModelProfile } from '../../../types'
import { resolveBuiltInToolCapabilityName } from '../tool_capabilities'

/**
 * Runtime-owned request-body fields that per-model `requestParams` overrides may
 * never touch. Overriding these would break the agent loop itself (model routing,
 * message history, tool binding, streaming), so they are silently dropped.
 */
const RUNTIME_OWNED_REQUEST_PARAMS = new Set<string>([
  'model',
  'messages',
  'tools',
  'tool_choice',
  'stream',
  'stream_options',
  'apiKey',
  'baseURL',
  'n',
])

/** Validate + sanitize a per-model requestParams override map (v3.2.9). */
export function sanitizeRequestParams(
  params: Record<string, string | number | boolean | object> | undefined,
): Record<string, string | number | boolean | object> {
  if (!params || typeof params !== 'object') return {}
  const out: Record<string, string | number | boolean | object> = {}
  for (const [key, value] of Object.entries(params)) {
    if (!key || RUNTIME_OWNED_REQUEST_PARAMS.has(key)) continue
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (value !== null && typeof value === 'object')
    ) {
      out[key] = value
    }
  }
  return out
}

/** Resolve the requestParams override for a model: model-level wins over profile-level. */
export function resolveRequestParams(
  item: ModelDefinition,
  profile?: ModelProfile | null,
): Record<string, string | number | boolean | object> {
  return {
    ...sanitizeRequestParams(profile?.requestParams),
    ...sanitizeRequestParams(item.requestParams),
  }
}

export function createChatModel(
  item: ModelDefinition,
  temperature: number,
  profile?: ModelProfile | null,
): ChatOpenAI {
  const requestParams = resolveRequestParams(item, profile)
  return new ChatOpenAI({
    model: item.model,
    apiKey: item.apiKey,
    configuration: {
      baseURL: item.baseUrl,
    },
    __includeRawResponse: true,
    temperature,
    maxRetries: 0,
    ...(Object.keys(requestParams).length > 0
      ? { modelKwargs: requestParams }
      : { modelKwargs: {} }),
  })
}

export function getMaxTokensForModel(modelName: string, settings: BackendSettings | null): number {
  const DEFAULT_MAX_TOKENS = 200000
  if (!settings || !modelName || modelName === 'unknown') return DEFAULT_MAX_TOKENS

  const modelItem = settings.models.items.find((m) => m.model === modelName)
  if (typeof modelItem?.maxTokens === 'number') return modelItem.maxTokens

  const modelItemByName = settings.models.items.find((m) => m.name === modelName)
  if (typeof modelItemByName?.maxTokens === 'number') return modelItemByName.maxTokens

  return DEFAULT_MAX_TOKENS
}

export function computeReadFileSupport(
  ...profiles: Array<ModelDefinition['profile'] | undefined>
): { image: boolean } {
  const image = profiles
    .filter((profile) => profile !== undefined)
    .every((profile) => profile?.imageInputs === true)
  return { image }
}

export function getEnabledBuiltInTools(allTools: any[], enabledMap: Record<string, boolean>) {
  return allTools.filter((tool: any) => {
    const name = tool?.function?.name ?? tool?.name
    if (!name) return false
    const capabilityName = resolveBuiltInToolCapabilityName(name)
    const enabled = enabledMap[capabilityName]
    return enabled !== false
  })
}

/** Dedupe tool definitions by name before binding them to a model (v3.7.3).
 * The built-in, MCP, and plugin tool lists come from independent sources;
 * a name collision or a source appended twice makes strict providers
 * (Grok, Fable) reject the whole request with HTTP 400 ("duplicate tool
 * definitions"). First definition wins; entries without a name are dropped. */
export function dedupeToolsByName(tools: any[]): any[] {
  const seen = new Set<string>()
  return tools.filter((tool: any) => {
    const name = tool?.function?.name ?? tool?.name
    if (!name || seen.has(name)) return false
    seen.add(name)
    return true
  })
}
