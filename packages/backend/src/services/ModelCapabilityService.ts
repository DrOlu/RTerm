import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage } from '@langchain/core/messages'
import { convertToOpenAITool } from '@langchain/core/utils/function_calling'
import type { ModelDefinition } from '../types'

export interface ModelCapabilityProfile {
  imageInputs: boolean
  textOutputs: boolean
  supportsStructuredOutput: boolean
  supportsObjectToolChoice: boolean
  testedAt: number
  ok: boolean
  error?: string
}

const TINY_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const PROBE_TIMEOUT_MODELS_MS = 8000
const PROBE_TIMEOUT_TEXT_MS = 8000
const PROBE_TIMEOUT_IMAGE_MS = 12000
const PROBE_TIMEOUT_STRUCTURED_MS = 20000
const PROBE_TIMEOUT_TOOL_CHOICE_MS = 20000
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

interface ProbeStepResult {
  ok: boolean
  error?: string
}

interface StreamProbeOptions {
  timeoutMs: number
  streamOperation: (signal: AbortSignal) => Promise<AsyncIterable<any>>
  successPredicate: (chunk: any) => boolean
  noOutputError: string
}

export class ModelCapabilityService {
  async probe(model: ModelDefinition): Promise<ModelCapabilityProfile> {
    const testedAt = Date.now()
    if (!model.model || !model.apiKey) {
      return {
        imageInputs: false,
        textOutputs: false,
        supportsStructuredOutput: false,
        supportsObjectToolChoice: false,
        testedAt,
        ok: false,
        error: 'Missing model or apiKey'
      }
    }

    const structuredMode = this.resolveStructuredOutputMode(model)
    const [textCheck, imageCheck, structuredOutputCheck, objectToolChoiceCheck] = await Promise.all([
      this.checkTextOutputs(model),
      this.checkImageInputs(model),
      structuredMode === 'auto'
        ? this.checkStructuredOutput(model)
        : Promise.resolve<ProbeStepResult>({ ok: structuredMode === 'on' }),
      this.checkObjectToolChoice(model)
    ])
    const activeCheck = textCheck.ok
      ? { ok: true as const }
      : await this.checkActiveByModelsEndpoint(model)

    const errors: string[] = []
    if (!imageCheck.ok && imageCheck.error) errors.push(`image: ${imageCheck.error}`)
    if (!structuredOutputCheck.ok && structuredOutputCheck.error) {
      errors.push(`structured_output: ${structuredOutputCheck.error}`)
    }
    if (!objectToolChoiceCheck.ok && objectToolChoiceCheck.error) {
      errors.push(`tool_choice_object: ${objectToolChoiceCheck.error}`)
    }
    if (textCheck.error) errors.push(`text: ${textCheck.error}`)
    if (!activeCheck.ok && activeCheck.error) errors.push(`active: ${activeCheck.error}`)

    return {
      imageInputs: imageCheck.ok,
      textOutputs: textCheck.ok,
      supportsStructuredOutput: structuredOutputCheck.ok,
      supportsObjectToolChoice: objectToolChoiceCheck.ok,
      testedAt,
      ok: textCheck.ok || activeCheck.ok,
      error: errors.length > 0 ? errors.join(' | ') : undefined
    }
  }

  private createProbeClient(model: ModelDefinition): ChatOpenAI {
    return new ChatOpenAI({
      model: model.model,
      apiKey: model.apiKey,
      configuration: {
        baseURL: model.baseUrl
      },
      temperature: 0
    })
  }

  private buildModelsEndpoint(baseUrl?: string): string {
    const normalized = String(baseUrl || '').trim().replace(/\/+$/, '')
    if (!normalized) return `${DEFAULT_OPENAI_BASE_URL}/models`
    if (/\/v1$/i.test(normalized)) return `${normalized}/models`
    return `${normalized}/v1/models`
  }

  private async checkActiveByModelsEndpoint(model: ModelDefinition): Promise<ProbeStepResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MODELS_MS)
    const endpoint = this.buildModelsEndpoint(model.baseUrl)

    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${model.apiKey || ''}`,
          Accept: 'application/json'
        },
        signal: controller.signal
      })

      if (!response.ok) {
        return {
          ok: false,
          error: `HTTP ${response.status} ${response.statusText}`.trim()
        }
      }

      const payload = await response.json().catch(() => undefined)
      const data = payload && typeof payload === 'object' ? (payload as any).data : undefined
      if (Array.isArray(data) && data.length > 0) {
        const listed = data.some((item: any) => item && typeof item.id === 'string' && item.id === model.model)
        if (!listed) {
          return { ok: false, error: `Model "${model.model}" not found in /v1/models` }
        }
      }

      return { ok: true }
    } catch (err) {
      if (this.isAbortError(err)) {
        return { ok: false, error: `Timeout after ${PROBE_TIMEOUT_MODELS_MS}ms` }
      }
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private async checkTextOutputs(model: ModelDefinition): Promise<ProbeStepResult> {
    const client = this.createProbeClient(model)
    return await this.runStreamProbe({
      timeoutMs: PROBE_TIMEOUT_TEXT_MS,
      streamOperation: async (signal) =>
        await client.stream(
          [
            new HumanMessage(
              'Do not think. Reply immediately with exactly: OK'
            )
          ],
          { signal }
        ),
      successPredicate: (chunk) => this.chunkHasAnyStreamData(chunk),
      noOutputError: 'No stream data was received before stream completion.'
    })
  }

  private async checkImageInputs(model: ModelDefinition): Promise<ProbeStepResult> {
    const client = this.createProbeClient(model)
    return await this.runStreamProbe({
      timeoutMs: PROBE_TIMEOUT_IMAGE_MS,
      streamOperation: async (signal) =>
        await client.stream(
          [
            new HumanMessage({
              content: [
                {
                  type: 'text',
                  text: 'Do not think. Ignore the image content and reply immediately with exactly: OK'
                },
                {
                  type: 'image_url',
                  image_url: { url: `data:image/png;base64,${TINY_IMAGE_BASE64}` }
                }
              ]
            })
          ],
          { signal }
        ),
      successPredicate: (chunk) => this.chunkHasAnyStreamData(chunk),
      noOutputError: 'No stream data was received for image-input probe before stream completion.'
    })
  }

  private async checkStructuredOutput(model: ModelDefinition): Promise<ProbeStepResult> {
    const client = this.createProbeClient(model)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_STRUCTURED_MS)

    try {
      const structured = client.withStructuredOutput(
        {
          type: 'object',
          properties: {
            ok: {
              type: 'boolean',
              description: 'Whether the probe request succeeded.'
            }
          },
          required: ['ok'],
          additionalProperties: false
        } as any,
        { method: 'jsonSchema' }
      )
      const output = await structured.invoke(
        [
          new HumanMessage(
            'Do not think. Return only the structured output with one boolean field: ok. Set ok to true.'
          )
        ],
        { signal: controller.signal }
      ) as any
      if (!output || typeof output.ok !== 'boolean') {
        return { ok: false, error: 'Structured output was not parsed into the expected boolean schema.' }
      }
      return { ok: true }
    } catch (err) {
      if (this.isAbortError(err)) {
        return { ok: false, error: `Timeout after ${PROBE_TIMEOUT_STRUCTURED_MS}ms` }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  private async checkObjectToolChoice(model: ModelDefinition): Promise<ProbeStepResult> {
    const client = this.createProbeClient(model)
    const toolName = 'capability_probe_tool'
    const tool = convertToOpenAITool({
      name: toolName,
      description: 'A tiny capability probe tool.',
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' }
        },
        required: ['ok'],
        additionalProperties: false
      }
    } as any)
    const modelWithTool = client.bindTools([tool], {
      tool_choice: {
        type: 'function',
        function: { name: toolName }
      } as any
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_TOOL_CHOICE_MS)

    try {
      const response = await modelWithTool.invoke(
        [
          new HumanMessage(
            'Do not think. Call the provided function immediately with {"ok": true}.'
          )
        ],
        { signal: controller.signal }
      ) as any
      const args = this.extractNamedToolCallArgs(response, toolName)
      if (!args) {
        return {
          ok: false,
          error: 'Model did not return the forced function tool call for object tool_choice.'
        }
      }
      if (typeof args.ok !== 'boolean') {
        return {
          ok: false,
          error: 'Object tool_choice response did not parse into expected boolean args.'
        }
      }
      if (args.ok !== true) {
        return {
          ok: false,
          error: 'Object tool_choice function call returned ok=false.'
        }
      }
      return { ok: true }
    } catch (err) {
      if (this.isAbortError(err)) {
        return { ok: false, error: `Timeout after ${PROBE_TIMEOUT_TOOL_CHOICE_MS}ms` }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  private async runStreamProbe(options: StreamProbeOptions): Promise<ProbeStepResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    let sawExpectedOutput = false

    try {
      const stream = await options.streamOperation(controller.signal)
      for await (const chunk of stream) {
        if (!options.successPredicate(chunk)) continue
        sawExpectedOutput = true
        controller.abort()
        break
      }

      if (sawExpectedOutput) {
        return { ok: true }
      }
      return { ok: false, error: options.noOutputError }
    } catch (err) {
      if (this.isAbortError(err)) {
        if (sawExpectedOutput) {
          return { ok: true }
        }
        return { ok: false, error: `Timeout after ${options.timeoutMs}ms` }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  private chunkHasTextOutput(chunk: any): boolean {
    const text = this.extractTextFromContent(chunk?.content)
    return text.trim().length > 0
  }

  private chunkHasAnyStreamData(chunk: any): boolean {
    if (chunk == null) return false
    if (typeof chunk !== 'object') return true
    if (this.chunkHasTextOutput(chunk) || this.chunkHasToolCallOutput(chunk)) return true
    if (Array.isArray(chunk?.content) && chunk.content.length > 0) return true
    if (chunk?.response_metadata || chunk?.usage_metadata || chunk?.additional_kwargs) return true
    return Object.keys(chunk).length > 0
  }

  private chunkHasToolCallOutput(chunk: any): boolean {
    if (Array.isArray(chunk?.tool_call_chunks) && chunk.tool_call_chunks.length > 0) {
      return true
    }
    if (Array.isArray(chunk?.tool_calls) && chunk.tool_calls.length > 0) {
      return true
    }
    if (Array.isArray(chunk?.additional_kwargs?.tool_calls) && chunk.additional_kwargs.tool_calls.length > 0) {
      return true
    }
    return false
  }

  private extractNamedToolCallArgs(response: any, toolName: string): Record<string, unknown> | null {
    const parsedToolCalls = Array.isArray(response?.tool_calls) ? response.tool_calls : []
    const matchedParsed = parsedToolCalls.find((call: any) => call?.name === toolName) || parsedToolCalls[0]
    const parsedArgs = this.parseToolArgs(matchedParsed?.args)
    if (parsedArgs) return parsedArgs

    const rawToolCalls = Array.isArray(response?.additional_kwargs?.tool_calls)
      ? response.additional_kwargs.tool_calls
      : []
    const matchedRaw = rawToolCalls.find((call: any) => call?.function?.name === toolName) || rawToolCalls[0]
    return this.parseToolArgs(matchedRaw?.function?.arguments)
  }

  private parseToolArgs(rawArgs: unknown): Record<string, unknown> | null {
    if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
      return rawArgs as Record<string, unknown>
    }
    if (typeof rawArgs !== 'string') return null

    try {
      const parsed = JSON.parse(rawArgs)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return null
    } catch {
      return null
    }
  }

  private extractTextFromContent(content: unknown): string {
    if (typeof content === 'string') {
      return content
    }
    if (!Array.isArray(content)) {
      return ''
    }
    return content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as any).text === 'string'
          ? (part as any).text
          : ''
      )
      .join('')
  }

  private isAbortError(err: unknown): boolean {
    if (!err) return false
    if (err instanceof Error) {
      return err.name === 'AbortError' || err.message === 'AbortError'
    }
    return false
  }

  private resolveStructuredOutputMode(model: ModelDefinition): 'auto' | 'on' | 'off' {
    if (model.structuredOutputMode === 'on' || model.structuredOutputMode === 'off') {
      return model.structuredOutputMode
    }
    return 'auto'
  }
}
