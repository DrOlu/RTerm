import { mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages, type BaseMessage } from '@langchain/core/messages'

interface MessageClonePatch {
  content?: unknown
  additionalKwargs?: Record<string, unknown>
}

/**
 * Rebuild a message by patching its stored representation.
 * This avoids spreading a BaseMessage instance into constructor kwargs,
 * which can recursively embed lc_* serialization metadata.
 */
export function cloneMessageWithPatch(
  message: BaseMessage,
  patch: MessageClonePatch
): BaseMessage {
  const storedMessages = mapChatMessagesToStoredMessages([message]) as any[]
  const stored = storedMessages[0]
  if (!stored?.data) {
    return message
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'content')) {
    stored.data.content = patch.content
  }
  if (patch.additionalKwargs !== undefined) {
    stored.data.additional_kwargs = patch.additionalKwargs
  }

  const rebuilt = mapStoredMessagesToChatMessages(storedMessages)[0]
  if (!rebuilt) {
    return message
  }
  ;(rebuilt as any).id = (message as any).id
  return rebuilt
}
