import React from 'react'
import { renderMentionContent, renderMentionText } from './MentionParser'
import { normalizeSessionTitleText } from './sessionTitleDisplay'

function assertEqual<T>(actual: T, expected: T, message: string): void {
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

const textOf = (node: string | React.ReactElement): string => {
  if (typeof node === 'string') return node
  return String(node.props.children || '')
}

const elementAt = (elements: React.ReactElement[], index: number): React.ReactElement<Record<string, unknown>> => {
  const element = elements[index]
  assertCondition(!!element, `expected rendered element at index ${index}`)
  return element as React.ReactElement<Record<string, unknown>>
}

runCase('legacy user paste label is rendered as literal text, not preview text', () => {
  const token = '[MENTION_USER_PASTE:#/tmp/paste.txt##preview text#]'
  const input = `before ${token} after`
  assertEqual(renderMentionText(input), input, 'plain mention text should keep legacy paste token literal')
  assertEqual(normalizeSessionTitleText(input), input, 'session title normalization should keep legacy paste token literal')
})

runCase('legacy user paste label does not render as a mention badge', () => {
  const token = '[MENTION_USER_PASTE:#/tmp/paste.txt##preview text#]'
  const nodes = renderMentionContent(`before ${token} after`)

  assertEqual(nodes.length, 1, 'paste token should not be split into a mention node')
  assertEqual(nodes[0], `before ${token} after`, 'paste token should stay in the surrounding text')
})

runCase('dangling legacy user paste label is not normalized to preview text', () => {
  const dangling = 'title [MENTION_USER_PASTE:#/tmp/paste.txt##preview'
  assertEqual(renderMentionText(dangling), dangling, 'dangling paste token should remain literal')
  assertEqual(normalizeSessionTitleText(dangling), dangling, 'dangling paste title should remain literal')
})

runCase('supported mention rendering still produces expected badges and labels', () => {
  const nodes = renderMentionContent(
    'Use [MENTION_SKILL:#writing-code-principles#] in [MENTION_TAB:#main##tab-1#] for [MENTION_FILE:#/tmp/report.md#] and [MENTION_IMAGE:#/tmp/shot.png##shot.png#].',
  )

  const elements = nodes.filter(React.isValidElement)
  assertEqual(elements.length, 4, 'supported mentions should still render as badges')
  assertEqual(elementAt(elements, 0).props.className, 'mention-badge skill', 'skill badge class should remain')
  assertEqual(textOf(elementAt(elements, 0)), '@writing-code-principles', 'skill badge label should remain')
  assertEqual(elementAt(elements, 1).props.className, 'mention-badge terminal', 'terminal badge class should remain')
  assertEqual(textOf(elementAt(elements, 1)), '@main', 'terminal badge label should remain')
  assertEqual(elementAt(elements, 2).props.className, 'mention-badge file', 'file badge class should remain')
  assertEqual(textOf(elementAt(elements, 2)), 'report.md', 'file badge basename should remain')
  assertEqual(elementAt(elements, 3).props.className, 'mention-badge file', 'image badge class should remain')
  assertEqual(textOf(elementAt(elements, 3)), 'shot.png', 'image explicit label should remain')
})

runCase('supported title text still normalizes mention labels without touching paste-like text', () => {
  const normalized = renderMentionText(
    '[MENTION_TAB:#main##tab-1#] [MENTION_SKILL:#skill#] [MENTION_FILE:#/tmp/report.md#] [MENTION_IMAGE:#/tmp/shot.png##Screenshot#]',
  )

  assertEqual(normalized, '@main @skill report.md Screenshot', 'supported mention text normalization should remain stable')
})

runCase('mixed legacy paste and supported file mentions only badge supported mentions', () => {
  const pasteToken = '[MENTION_USER_PASTE:#/tmp/paste.txt##preview#]'
  const nodes = renderMentionContent(`${pasteToken} [MENTION_FILE:#/tmp/file.txt#]`)
  const elements = nodes.filter(React.isValidElement)

  assertEqual(elements.length, 1, 'only the supported file mention should become a badge')
  assertEqual(elementAt(elements, 0).props.className, 'mention-badge file', 'file mention should still use file badge class')
  assertCondition(
    nodes.some((node) => typeof node === 'string' && node.includes(pasteToken)),
    'legacy paste token should remain as text in mixed content',
  )
})
