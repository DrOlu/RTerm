import {
  autoTitle,
  createSessionState,
  normalizeDisplayText,
  previewFromSession,
} from './session-store'
import type { ChatMessage } from './types'

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

const makeMessage = (content: string): ChatMessage => ({
  id: 'm1',
  role: 'user',
  type: 'text',
  content,
  timestamp: 1,
})

runCase('legacy paste label stays literal in mobile display normalization', () => {
  const token = '[MENTION_USER_PASTE:#/tmp/paste.txt##preview#]'
  assertEqual(normalizeDisplayText(token), token, 'legacy paste token should not collapse to preview')
  assertEqual(autoTitle(token), token, 'mobile auto title should keep short legacy paste token literal')
})

runCase('mobile session preview does not collapse legacy paste label to preview', () => {
  const token = '[MENTION_USER_PASTE:#/tmp/paste.txt##preview#]'
  const session = createSessionState('s1')
  session.messages.push(makeMessage(token))

  const preview = previewFromSession(session)
  assertEqual(preview, token, 'mobile preview should keep legacy paste token literal')
  assertCondition(preview !== 'preview', 'mobile preview should not use the old paste preview label')
})

runCase('mobile supported mention normalization still renders compact display names', () => {
  assertEqual(normalizeDisplayText('[MENTION_TAB:#main##tab-1#]'), '@main', 'tab mention should normalize')
  assertEqual(normalizeDisplayText('[MENTION_SKILL:#skill#]'), '@skill', 'skill mention should normalize')
  assertEqual(normalizeDisplayText('[MENTION_FILE:#/tmp/report.md#]'), 'report.md', 'file mention should normalize')
  assertEqual(
    normalizeDisplayText('[MENTION_IMAGE:#/tmp/screenshot.png##Screenshot#]'),
    'Screenshot',
    'image mention should normalize',
  )
})
