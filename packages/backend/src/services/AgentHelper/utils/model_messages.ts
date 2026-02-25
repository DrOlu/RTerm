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
      const sanitizedMessages = stripRawResponseForModelInput(opts.messages)
      return await opts.operation(sanitizedMessages)
    },
    opts.maxRetries,
    opts.delaysMs,
    opts.signal
  )
}

export function buildDynamicRequestHistory(messages: BaseMessage[]): BaseMessage[] {
  const compacted = applyCompactionBoundary(messages)
  return applyPruneMaterialization(compacted)
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

function buildPrunedPlaceholder(content: unknown): string {
  const raw = typeof content === 'string' ? content : JSON.stringify(content)
  const estimate = TokenManager.estimate(raw)
  return `${TokenManager.PRUNED_CONTENT_PLACEHOLDER} Original length: ~${estimate} tokens.`
}
