import { observable } from 'mobx'
import {
  buildChatRenderItems,
  resolveSeamlessOverlayMessages,
} from './chatRenderModel'
import type { ChatMessage, ChatSession } from '../../stores/ChatStore'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    )
  }
}

const assertDeepEqual = (
  actual: unknown,
  expected: unknown,
  message: string,
): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}. expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    )
  }
}

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

const createMessage = (
  overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'type'>,
): ChatMessage => ({
  id: overrides.id,
  role: overrides.role,
  type: overrides.type,
  content: overrides.content || '',
  timestamp: 1,
  ...(overrides.backendMessageId
    ? { backendMessageId: overrides.backendMessageId }
    : {}),
  ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
  ...(typeof overrides.streaming === 'boolean'
    ? { streaming: overrides.streaming }
    : {}),
})

const createSession = (messages: ChatMessage[]): ChatSession => {
  const messagesById = observable.map<string, ChatMessage>()
  const messageIds: string[] = []
  messages.forEach((message) => {
    messagesById.set(message.id, message)
    messageIds.push(message.id)
  })
  return {
    id: 'session-1',
    title: 'Test Session',
    messagesById,
    messageIds,
    renderListVersion: 0,
    isThinking: false,
    isSessionBusy: false,
    lockedProfileId: null,
  }
}

runCase(
  'assistant runs are computed once and expose group-copy only on the tail row',
  () => {
    const session = createSession([
      createMessage({ id: 'u1', role: 'user', type: 'text', content: 'hello' }),
      createMessage({
        id: 'a1',
        role: 'assistant',
        type: 'text',
        content: 'first reply',
        streaming: false,
      }),
      createMessage({
        id: 'a2',
        role: 'assistant',
        type: 'command',
        content: 'ls',
        streaming: false,
      }),
      createMessage({ id: 'u2', role: 'user', type: 'text', content: 'next' }),
    ])

    const items = buildChatRenderItems(session, false)
    assertDeepEqual(
      items.map((item) => item.id),
      ['u1', 'a1', 'a2', 'u2'],
      'visible item ordering should stay stable',
    )
    assertEqual(
      items[1]?.mergeWithPreviousAssistant,
      false,
      'assistant run head should not merge with previous row',
    )
    assertEqual(
      items[2]?.mergeWithPreviousAssistant,
      true,
      'assistant run continuation should merge with previous assistant row',
    )
    assertEqual(
      items[1]?.showAssistantGroupCopy,
      false,
      'assistant run head should not show copy control',
    )
    assertEqual(
      items[2]?.showAssistantGroupCopy,
      true,
      'assistant run tail should show copy control',
    )
    assertDeepEqual(
      items[2]?.assistantGroupMessageIds,
      ['a1', 'a2'],
      'assistant run tail should expose the full assistant group',
    )
  },
)

runCase(
  'hidden non-terminal reasoning and retry-hint rows stay out of the render model',
  () => {
    const session = createSession([
      createMessage({ id: 'u1', role: 'user', type: 'text', content: 'hello' }),
      createMessage({
        id: 'r1',
        role: 'assistant',
        type: 'reasoning',
        content: 'intermediate reasoning',
        streaming: false,
      }),
      createMessage({
        id: 'hint1',
        role: 'system',
        type: 'alert',
        content: 'Retrying',
        metadata: { subToolLevel: 'info' },
      }),
      createMessage({
        id: 'a1',
        role: 'assistant',
        type: 'text',
        content: 'answer',
        streaming: false,
      }),
      createMessage({
        id: 'r2',
        role: 'assistant',
        type: 'reasoning',
        content: 'final reasoning',
        streaming: false,
      }),
    ])

    const items = buildChatRenderItems(session, false)
    assertDeepEqual(
      items.map((item) => item.id),
      ['u1', 'a1', 'r2'],
      'non-terminal reasoning and retry-hint rows should be filtered out',
    )
  },
)

runCase(
  'completed whitespace assistant messages and token rows do not become visible rows',
  () => {
    const session = createSession([
      createMessage({
        id: 'tokens',
        role: 'system',
        type: 'tokens_count',
        content: '',
      }),
      createMessage({
        id: 'blank',
        role: 'assistant',
        type: 'text',
        content: '   ',
        streaming: false,
      }),
      createMessage({
        id: 'live',
        role: 'assistant',
        type: 'text',
        content: '',
        streaming: true,
      }),
    ])

    const items = buildChatRenderItems(session, true)
    assertDeepEqual(
      items.map((item) => item.id),
      ['live'],
      'only the live streaming assistant row should remain visible',
    )
  },
)

runCase(
  'seamless overlay only includes the trailing overlay block',
  () => {
    const session = createSession([
      createMessage({ id: 'u1', role: 'user', type: 'text', content: 'hello' }),
      createMessage({
        id: 'err-old',
        role: 'assistant',
        type: 'error',
        content: 'old failure',
      }),
      createMessage({
        id: 'a1',
        role: 'assistant',
        type: 'text',
        content: 'recovered',
      }),
      createMessage({
        id: 'ask-current',
        role: 'assistant',
        type: 'ask',
        content: 'Need approval',
      }),
      createMessage({
        id: 'alert-current',
        role: 'assistant',
        type: 'alert',
        content: 'Current warning',
        metadata: { subToolLevel: 'warning' },
      }),
    ])

    const overlayMessages = resolveSeamlessOverlayMessages(session)
    assertDeepEqual(
      overlayMessages.map((message) => message.id),
      ['ask-current', 'alert-current'],
      'historical overlay rows should stop pinning once newer visible chat content exists',
    )
  },
)

runCase(
  'seamless overlay ignores hidden tail rows when keeping the current issue',
  () => {
    const session = createSession([
      createMessage({ id: 'u1', role: 'user', type: 'text', content: 'hello' }),
      createMessage({
        id: 'err-current',
        role: 'assistant',
        type: 'error',
        content: 'latest failure',
      }),
      createMessage({
        id: 'tokens',
        role: 'system',
        type: 'tokens_count',
        content: '',
      }),
    ])

    const overlayMessages = resolveSeamlessOverlayMessages(session)
    assertDeepEqual(
      overlayMessages.map((message) => message.id),
      ['err-current'],
      'hidden tail rows should not suppress the active overlay issue',
    )
  },
)

console.log('All chat render model extreme tests passed.')
