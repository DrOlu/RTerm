import { compactMessageSummary } from './state'
import type { ChatMessage } from './protocol'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

const makeTextMessage = (content: string): ChatMessage => ({
  id: 'm1',
  role: 'user',
  type: 'text',
  content,
  timestamp: 1,
})

runCase('legacy paste label is not collapsed to preview text in TUI compact summaries', () => {
  const token = '[MENTION_USER_PASTE:#/tmp/paste.txt##preview#]'
  const summary = compactMessageSummary(makeTextMessage(token), true)

  assertCondition(summary.includes('MENTION USER PASTE'), 'TUI summary should keep the legacy paste marker text')
  assertCondition(summary.includes('/tmp/paste.txt'), 'TUI summary should keep the legacy paste path')
  assertCondition(summary !== 'preview', 'TUI summary should not collapse to the old preview text')
})

runCase('TUI supported mention compact summaries still use display names', () => {
  assertEqual(
    compactMessageSummary(makeTextMessage('[MENTION_TAB:#main##tab-1#]'), true),
    '@main',
    'tab mention should normalize',
  )
  assertEqual(
    compactMessageSummary(makeTextMessage('[MENTION_SKILL:#skill#]'), true),
    '@skill',
    'skill mention should normalize',
  )
  assertEqual(
    compactMessageSummary(makeTextMessage('[MENTION_FILE:#/tmp/report.md#]'), true),
    'report.md',
    'file mention should normalize',
  )
})
