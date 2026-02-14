import type { BaseMessage } from '@langchain/core/messages'
import { mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages } from '@langchain/core/messages'

interface ToolCallHistoryCleanResult {
  messages: BaseMessage[]
  removedToolCallCount: number
}

function normalizeToolCallId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function collectToolResponseIds(storedMessages: any[]): Set<string> {
  const ids = new Set<string>()

  for (const storedMessage of storedMessages) {
    if (storedMessage?.type !== 'tool') continue
    const toolCallId = normalizeToolCallId(storedMessage?.data?.tool_call_id)
    if (toolCallId) {
      ids.add(toolCallId)
    }
  }

  return ids
}

function keepMatchedToolCalls(toolCalls: any[], toolResponseIds: Set<string>): { kept: any[]; removed: number } {
  const kept: any[] = []
  let removed = 0

  for (const toolCall of toolCalls) {
    const toolCallId = normalizeToolCallId(toolCall?.id)
    if (!toolCallId || !toolResponseIds.has(toolCallId)) {
      removed += 1
      continue
    }
    kept.push(toolCall)
  }

  return { kept, removed }
}

/**
 * Remove orphan tool calls from AI messages before persistence.
 * A tool call is considered orphan when no ToolMessage has a matching tool_call_id.
 */
export function removeUnmatchedToolCallsFromHistory(messages: BaseMessage[]): ToolCallHistoryCleanResult {
  if (messages.length === 0) {
    return { messages, removedToolCallCount: 0 }
  }

  const storedMessages = mapChatMessagesToStoredMessages(messages) as any[]
  const toolResponseIds = collectToolResponseIds(storedMessages)

  let removedToolCallCount = 0

  for (const storedMessage of storedMessages) {
    if (storedMessage?.type !== 'ai') continue

    const data = storedMessage?.data
    if (!data || !Array.isArray(data.tool_calls) || data.tool_calls.length === 0) continue

    const { kept, removed } = keepMatchedToolCalls(data.tool_calls, toolResponseIds)
    if (removed === 0) continue

    data.tool_calls = kept
    removedToolCallCount += removed

    const additionalToolCalls = data?.additional_kwargs?.tool_calls
    if (Array.isArray(additionalToolCalls)) {
      data.additional_kwargs.tool_calls = keepMatchedToolCalls(additionalToolCalls, toolResponseIds).kept
    }
  }

  if (removedToolCallCount === 0) {
    return { messages, removedToolCallCount: 0 }
  }

  return {
    messages: mapStoredMessagesToChatMessages(storedMessages),
    removedToolCallCount
  }
}
