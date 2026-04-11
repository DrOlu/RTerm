import { mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages } from '@langchain/core/messages'
import type { BaseMessage } from '@langchain/core/messages'
import { TokenManager } from '../TokenManager'
import { cloneMessageWithPatch } from './message_clone'

type RetryCapableHelpers = {
  invokeWithRetry: <T>(
    fn: (attempt: number) => Promise<T>,
    maxRetries?: number,
    delays?: number[],
    signal?: AbortSignal
  ) => Promise<T>
}

export function stripRawResponseForModelInput(messages: BaseMessage[]): BaseMessage[] {
  const stored = mapChatMessagesToStoredMessages(messages)
  const mutated = stripRawResponseFromStoredMessages(stored as any[])
  return mutated ? mapStoredMessagesToChatMessages(stored) : messages
}

export function sanitizeStoredMessagesForChatRuntime(storedMessages: any[]): {
  messages: any[]
  removedCount: number
} {
  if (!Array.isArray(storedMessages) || storedMessages.length === 0) {
    return {
      messages: Array.isArray(storedMessages) ? storedMessages : [],
      removedCount: 0
    }
  }

  const kept: any[] = []
  let removedCount = 0

  for (const storedMessage of storedMessages) {
    try {
      const rebuilt = mapStoredMessagesToChatMessages([storedMessage] as any[])
      if (!Array.isArray(rebuilt) || rebuilt.length === 0) {
        removedCount += 1
        continue
      }
      kept.push(storedMessage)
    } catch {
      removedCount += 1
    }
  }

  return removedCount > 0
    ? { messages: kept, removedCount }
    : { messages: storedMessages, removedCount: 0 }
}

export function stripRawResponseFromStoredMessages(storedMessages: any[]): boolean {
  let mutated = false
  for (const msg of storedMessages) {
    const additionalKwargs = msg?.data?.additional_kwargs
    if (additionalKwargs && Object.prototype.hasOwnProperty.call(additionalKwargs, '__raw_response')) {
      delete additionalKwargs.__raw_response
      mutated = true
    }
  }
  return mutated
}

export async function invokeWithRetryAndSanitizedInput<T>(opts: {
  helpers: RetryCapableHelpers
  messages: BaseMessage[]
  modelSupportsImage?: boolean
  signal: AbortSignal | undefined
  operation: (sanitizedMessages: BaseMessage[]) => Promise<T>
  onRetry?: (attempt: number) => void
  maxRetries: number
  delaysMs: number[]
}): Promise<T> {
  return await opts.helpers.invokeWithRetry(
    async (attempt) => {
      if (attempt > 0) {
        opts.onRetry?.(attempt)
      }
      const sanitizedMessages = sanitizeModelInputMessages(
        stripRawResponseForModelInput(opts.messages),
        { modelSupportsImage: opts.modelSupportsImage }
      )
      return await opts.operation(sanitizedMessages)
    },
    opts.maxRetries,
    opts.delaysMs,
    opts.signal
  )
}

export function buildDynamicRequestHistory(
  messages: BaseMessage[],
  options?: { modelSupportsImage?: boolean }
): BaseMessage[] {
  const compacted = applyCompactionBoundary(messages)
  const materialized = applyPruneMaterialization(compacted)
  return sanitizeModelInputMessages(materialized, options)
}

function applyCompactionBoundary(messages: BaseMessage[]): BaseMessage[] {
  let lastCompactionIndex = -1
  for (let i = 0; i < messages.length; i++) {
    if (TokenManager.hasLastCompactionFlag(messages[i])) {
      lastCompactionIndex = i
    }
  }
  if (lastCompactionIndex < 0) return messages

  // Keep leading system prompts untouched, then keep from the last compaction marker onward.
  let leadingSystemCount = 0
  while (leadingSystemCount < messages.length && messages[leadingSystemCount]?.type === 'system') {
    leadingSystemCount += 1
  }

  const startIndex = Math.max(lastCompactionIndex, leadingSystemCount)
  const head = messages.slice(0, leadingSystemCount)
  const tail = messages.slice(startIndex)
  return [...head, ...tail]
}

function applyPruneMaterialization(messages: BaseMessage[]): BaseMessage[] {
  let changed = false
  const nextMessages = messages.map((message) => {
    if (!TokenManager.hasPruneLabel(message)) {
      return message
    }
    changed = true
    return cloneMessageWithPatch(message, {
      content: buildPrunedPlaceholder(message.content)
    })
  })
  return changed ? nextMessages : messages
}

export function sanitizeModelInputMessages(
  messages: BaseMessage[],
  options?: { modelSupportsImage?: boolean }
): BaseMessage[] {
  if (options?.modelSupportsImage !== false) {
    return messages
  }

  let changed = false
  const nextMessages = messages.map((message) => {
    const sanitized = sanitizeMessageContentForTextOnlyModel(message.content)
    if (!sanitized.changed) {
      return message
    }
    changed = true
    return cloneMessageWithPatch(message, {
      content: sanitized.content
    })
  })
  return changed ? nextMessages : messages
}

function sanitizeMessageContentForTextOnlyModel(
  content: unknown
): { content: unknown; changed: boolean } {
  if (!Array.isArray(content)) {
    return { content, changed: false }
  }

  let changed = false
  const nextParts: unknown[] = []
  const textParts: string[] = []

  for (const part of content) {
    if (isImageContentPart(part)) {
      changed = true
      continue
    }
    nextParts.push(part)
    if (isTextContentPart(part)) {
      textParts.push(part.text)
    } else if (typeof part === 'string') {
      textParts.push(part)
    }
  }

  if (!changed) {
    return { content, changed: false }
  }

  const mergedText = textParts.join('').trim()
  if (nextParts.length === 0) {
    return {
      content: mergedText || '[Image content omitted because the target model does not support image inputs.]',
      changed: true
    }
  }

  if (nextParts.every((part) => isTextContentPart(part) || typeof part === 'string')) {
    return {
      content: mergedText || '[Image content omitted because the target model does not support image inputs.]',
      changed: true
    }
  }

  return { content: nextParts, changed: true }
}

function isImageContentPart(part: unknown): boolean {
  return !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'image_url'
}

function isTextContentPart(part: unknown): part is { type: 'text'; text: string } {
  return (
    !!part &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'text' &&
    typeof (part as { text?: unknown }).text === 'string'
  )
}

function buildPrunedPlaceholder(content: unknown): string {
  const raw = typeof content === 'string' ? content : JSON.stringify(content)
  const estimate = TokenManager.estimate(raw)
  return `${TokenManager.PRUNED_CONTENT_PLACEHOLDER} Original length: ~${estimate} tokens.`
}
